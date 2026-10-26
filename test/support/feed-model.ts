import { isAtUriString } from '@atproto/syntax'

import { uriOf, type SeedRecord } from './hyperindex-fixture.js'
import { MAX_GROUP_ROWS } from '../../src/feed/types.js'

/**
 * An independent in-memory model of the activity feed's selection rules. The
 * integration tests page the real SQL feed and compare it with this model, so
 * the two implementations have to agree on selection, order, runs, chunking,
 * and the continued and capped flags.
 *
 * `run` numbers the burst and audio runs in feed order, so a test can compare
 * which items belong to one run without knowing the service's group keys.
 */

export type ModelItem =
  | {
      readonly type: 'record'
      readonly kind: string
      readonly uri: string
      readonly did: string
      readonly at: number
    }
  | {
      readonly type: 'repost'
      readonly uri: string
      readonly did: string
      readonly subject: string
      readonly at: number
    }
  | {
      readonly type: 'burst'
      readonly did: string
      readonly total: number
      readonly from: number
      readonly to: number
      readonly subjects: readonly string[]
      readonly run: number
      readonly continued: boolean
      readonly capped: boolean
    }
  | {
      readonly type: 'audio'
      readonly did: string
      readonly deployment: string | null
      readonly total: number
      readonly from: number
      readonly to: number
      readonly subjects: readonly string[]
      readonly run: number
      readonly continued: boolean
      readonly capped: boolean
    }

interface Row {
  readonly record: SeedRecord
  readonly uri: string
  readonly at: number
  readonly kind: string
}

const RUN_GAP_MS = 12 * 60 * 60 * 1000
const SAMPLE_SIZE = 20
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000
const REPOST_SUBJECT_KINDS = new Set(['post', 'observation', 'project'])
/** What the Lexicon's `did` format accepts: the owner of a folder must be one. */
const DID_SHAPE = /^did:[a-z]+:[A-Za-z0-9._:%-]*[A-Za-z0-9._-]$/
const MAX_DID_LENGTH = 2048

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const kindOf = (record: SeedRecord): string | undefined => {
  const json = record.json ?? {}
  switch (record.collection) {
    case 'org.hypercerts.collection':
      return json.type === 'project' || json.type === 'Project'
        ? 'project'
        : undefined
    case 'app.certified.actor.organization':
      return 'organization'
    case 'app.gainforest.feed.post': {
      const tags = Array.isArray(json.tags) ? (json.tags as unknown[]) : []
      return (json.reply === undefined || json.reply === null) &&
        !tags.includes('community-event')
        ? 'post'
        : undefined
    }
    case 'app.gainforest.dwc.occurrence':
      return 'observation'
    case 'app.gainforest.feed.repost':
      return 'repost'
    case 'app.gainforest.ac.audio':
      return 'audio'
    default:
      return undefined
  }
}

const isBioacoustic = (record: SeedRecord): boolean => {
  const json = record.json ?? {}
  if (typeof json.dynamicProperties !== 'string') return false
  let parsed: unknown
  try {
    parsed = JSON.parse(json.dynamicProperties)
  } catch {
    return false
  }
  if (!isObject(parsed) || !isObject(parsed.gainforestBioacoustics)) {
    return false
  }
  const segment = parsed.gainforestBioacoustics
  const media =
    typeof json.associatedMedia === 'string'
      ? json.associatedMedia.split('|').map((part) => part.trim())
      : []
  return (
    segment.version === 1 &&
    typeof segment.sourceAudioUri === 'string' &&
    ['bird', 'frog', 'insect', 'other', 'note'].includes(
      String(segment.labelCategory),
    ) &&
    [
      'startTimeSeconds',
      'endTimeSeconds',
      'minFrequencyHz',
      'maxFrequencyHz',
    ].every((field) => typeof segment[field] === 'number') &&
    media.includes(segment.sourceAudioUri)
  )
}

/**
 * Newest first. Equal timestamps break by URI. The database collation decides
 * what "larger" means for a URI, so tests pass the database's own order; the
 * fallback is plain string order.
 */
const newestFirstBy =
  (uriRank: ReadonlyMap<string, number> | undefined) =>
  (a: Row, b: Row): number => {
    if (a.at !== b.at) return b.at - a.at
    if (a.uri === b.uri) return 0
    if (uriRank !== undefined) {
      return (uriRank.get(a.uri) ?? 0) - (uriRank.get(b.uri) ?? 0)
    }
    return a.uri < b.uri ? 1 : -1
  }

/**
 * Whether the feed reads a record with this createdAt: not before 1970 and no
 * more than five minutes ahead. Years above 9999 do not parse and are out.
 */
const inRange = (createdAt: string | null): boolean => {
  if (createdAt === null) return false
  const at = Date.parse(createdAt)
  return (
    Number.isFinite(at) && at >= 0 && at <= Date.now() + FUTURE_TOLERANCE_MS
  )
}

const repostSubjectUri = (record: SeedRecord): string => {
  const subject = record.json?.subject
  return isObject(subject) && typeof subject.uri === 'string' ? subject.uri : ''
}

/**
 * The recorder folder is `deploymentRef` when it is an AT-URI. The folder's
 * owner is the account in that AT-URI when it is a valid DID, whoever stored
 * the recording. Without a folder, or when the authority is a handle or
 * anything else that is not a valid DID, the recording's own account owns it.
 */
const audioKey = (
  record: SeedRecord,
): { readonly owner: string; readonly folder: string | null } => {
  const ref = record.json?.deploymentRef
  const folder = typeof ref === 'string' && ref.startsWith('at://') ? ref : null
  const authority = folder?.slice('at://'.length).split('/')[0]
  const isDid =
    authority !== undefined &&
    authority.length <= MAX_DID_LENGTH &&
    DID_SHAPE.test(authority)
  return { owner: isDid ? authority : record.did, folder }
}

/** Whether `row` is the next row of the run that ends with `previous`. */
const joinsRun = (previous: Row, row: Row): boolean => {
  if (previous.kind !== row.kind || previous.at - row.at > RUN_GAP_MS) {
    return false
  }
  if (row.kind === 'observation') {
    return (
      previous.record.did === row.record.did &&
      !isBioacoustic(previous.record) &&
      !isBioacoustic(row.record)
    )
  }
  if (row.kind === 'audio') {
    const before = audioKey(previous.record)
    const after = audioKey(row.record)
    return before.owner === after.owner && before.folder === after.folder
  }
  return false
}

/**
 * The full feed, newest first, for the given records. A run is cut into
 * chunks of at most `maxGroupRows` rows. Every chunk after the first one
 * continues its run, and a full chunk that the run goes on after is capped.
 */
export const modelFeed = (
  records: readonly SeedRecord[],
  options: {
    filter: string
    followed?: ReadonlySet<string>
    uriRank?: ReadonlyMap<string, number>
    maxGroupRows?: number
  },
): ModelItem[] => {
  const maxGroupRows = options.maxGroupRows ?? MAX_GROUP_ROWS
  const newestFirst = newestFirstBy(options.uriRank)
  const isValid = (record: SeedRecord): boolean =>
    (record.validation ?? 'valid') === 'valid'
  // A repost resolves when its subject is a valid record that would itself be
  // a feed record; the subject's own createdAt only decides whether the
  // subject is in the feed.
  const byUri = new Map(
    records.filter(isValid).map((record) => [uriOf(record), record]),
  )

  const rows: Row[] = []
  for (const record of records) {
    if (!isValid(record) || !inRange(record.createdAt)) continue
    const kind = kindOf(record)
    if (kind === undefined) continue
    if (options.filter !== 'all' && options.filter !== kind) continue
    const scopedTo = kind === 'audio' ? audioKey(record).owner : record.did
    if (options.followed !== undefined && !options.followed.has(scopedTo)) {
      continue
    }
    if (kind === 'repost') {
      const subject = byUri.get(repostSubjectUri(record))
      const subjectKind = subject === undefined ? undefined : kindOf(subject)
      if (
        subject === undefined ||
        subjectKind === undefined ||
        !REPOST_SUBJECT_KINDS.has(subjectKind) ||
        subject.did === record.did
      ) {
        continue
      }
    }
    rows.push({
      record,
      uri: uriOf(record),
      at: Date.parse(record.createdAt ?? ''),
      kind,
    })
  }
  rows.sort(newestFirst)

  // Runs are rows that are adjacent in the merged order and join each other.
  const runs: Row[][] = []
  for (const row of rows) {
    const current = runs.at(-1)
    const previous = current?.at(-1)
    if (
      current !== undefined &&
      previous !== undefined &&
      joinsRun(previous, row)
    ) {
      current.push(row)
    } else {
      runs.push([row])
    }
  }

  const items: ModelItem[] = []
  let runNumber = 0
  for (const run of runs) {
    const [first] = run
    if (first === undefined) continue
    // A lone observation stays a record item; audio is always a group.
    if (
      first.kind !== 'audio' &&
      (first.kind !== 'observation' || run.length === 1)
    ) {
      items.push(singleItem(first))
      continue
    }
    for (let start = 0; start < run.length; start += maxGroupRows) {
      const chunk = run.slice(start, start + maxGroupRows)
      items.push(
        groupItem(chunk, {
          run: runNumber,
          continued: start > 0,
          capped: start + maxGroupRows < run.length,
        }),
      )
    }
    runNumber += 1
  }
  return items
}

const singleItem = (row: Row): ModelItem => {
  if (row.kind === 'repost') {
    return {
      type: 'repost',
      uri: row.uri,
      did: row.record.did,
      subject: repostSubjectUri(row.record),
      at: row.at,
    }
  }
  return {
    type: 'record',
    kind: row.kind,
    uri: row.uri,
    did: row.record.did,
    at: row.at,
  }
}

const groupItem = (
  chunk: readonly Row[],
  flags: { run: number; continued: boolean; capped: boolean },
): ModelItem => {
  const first = chunk[0]
  const last = chunk.at(-1)
  if (first === undefined || last === undefined) {
    throw new Error('A chunk has at least one row.')
  }
  const common = {
    total: chunk.length,
    from: last.at,
    to: first.at,
    subjects: chunk.slice(0, SAMPLE_SIZE).map((row) => row.uri),
    ...flags,
  }
  if (first.kind === 'audio') {
    const { owner, folder } = audioKey(first.record)
    // The recordings group by `folder` whatever it holds, but the item names it
    // only when it is a valid AT-URI: `deployment` is `format: at-uri`, and the
    // output check is strict.
    const deployment = folder !== null && isAtUriString(folder) ? folder : null
    return { type: 'audio', did: owner, deployment, ...common }
  }
  return { type: 'burst', did: first.record.did, ...common }
}
