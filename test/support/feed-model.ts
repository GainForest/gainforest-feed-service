import { uriOf, type SeedRecord } from './hyperindex-fixture.js'

/**
 * An independent in-memory model of the activity feed's selection rules. The
 * integration tests page the real SQL feed and compare it with this model, so
 * the two implementations have to agree on selection, order, bursts, and
 * audio groups.
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
    }
  | {
      readonly type: 'audio'
      readonly did: string
      readonly day: string
      readonly deployment: string | null
      readonly total: number
      readonly at: number
      readonly subjects: readonly string[]
    }

interface Row {
  readonly record: SeedRecord
  readonly uri: string
  readonly at: number
  readonly kind: string
}

const BURST_GAP_MS = 12 * 60 * 60 * 1000
const SAMPLE_SIZE = 20
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000
const REPOST_SUBJECT_KINDS = new Set(['post', 'observation', 'project'])

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
 * owner is the account in that AT-URI when it is a DID, whoever stored the
 * recording. Without a folder the recording's own account owns it.
 */
const audioKey = (
  record: SeedRecord,
): { readonly owner: string; readonly folder: string | null } => {
  const ref = record.json?.deploymentRef
  const folder = typeof ref === 'string' && ref.startsWith('at://') ? ref : null
  const authority =
    folder?.startsWith('at://did:') === true
      ? folder.slice('at://'.length).split('/')[0]
      : undefined
  return { owner: authority ?? record.did, folder }
}

/** The full feed, newest first, for the given records. */
export const modelFeed = (
  records: readonly SeedRecord[],
  options: {
    filter: string
    followed?: ReadonlySet<string>
    uriRank?: ReadonlyMap<string, number>
  },
): ModelItem[] => {
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

  const groupKey = (row: Row): string => {
    const { owner, folder } = audioKey(row.record)
    return `${owner}|${folder ?? ''}|${new Date(row.at).toISOString().slice(0, 10)}`
  }
  const audioGroups = new Map<string, Row[]>()
  const stream: Row[] = []
  for (const row of rows) {
    if (row.kind !== 'audio') {
      stream.push(row)
      continue
    }
    const key = groupKey(row)
    audioGroups.set(key, [...(audioGroups.get(key) ?? []), row])
  }
  for (const group of audioGroups.values()) {
    const [head] = [...group].sort(newestFirst)
    if (head !== undefined) stream.push(head)
  }
  stream.sort(newestFirst)

  const items: ModelItem[] = []
  let run: Row[] = []
  const burstable = (row: Row): boolean =>
    row.kind === 'observation' && !isBioacoustic(row.record)
  const flush = (): void => {
    const [first] = run
    const last = run.at(-1)
    if (first === undefined || last === undefined) return
    if (run.length === 1) {
      items.push(rowItem(first, audioGroups, groupKey, newestFirst))
    } else {
      items.push({
        type: 'burst',
        did: first.record.did,
        total: run.length,
        from: last.at,
        to: first.at,
        subjects: run.slice(0, SAMPLE_SIZE).map((row) => row.uri),
      })
    }
    run = []
  }
  for (const row of stream) {
    const previous = run.at(-1)
    const continues =
      previous !== undefined &&
      burstable(row) &&
      burstable(previous) &&
      previous.record.did === row.record.did &&
      previous.at - row.at <= BURST_GAP_MS
    if (!continues) flush()
    run.push(row)
  }
  flush()
  return items
}

const rowItem = (
  row: Row,
  audioGroups: ReadonlyMap<string, readonly Row[]>,
  groupKey: (row: Row) => string,
  newestFirst: (a: Row, b: Row) => number,
): ModelItem => {
  if (row.kind === 'repost') {
    return {
      type: 'repost',
      uri: row.uri,
      did: row.record.did,
      subject: repostSubjectUri(row.record),
      at: row.at,
    }
  }
  if (row.kind === 'audio') {
    const { owner, folder } = audioKey(row.record)
    const group = [...(audioGroups.get(groupKey(row)) ?? [])].sort(newestFirst)
    return {
      type: 'audio',
      did: owner,
      day: new Date(row.at).toISOString().slice(0, 10),
      deployment: folder,
      total: group.length,
      at: row.at,
      subjects: group.slice(0, SAMPLE_SIZE).map((member) => member.uri),
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
