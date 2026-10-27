import { isAtUriString } from '@atproto/syntax'

import { uriOf, type SeedRecord } from './hyperindex-fixture.js'
import { BATCH_ROWS, REQUEST_ROWS } from '../../src/feed/query.js'
import { GROUP_SAMPLE_SIZE, MIN_GROUP_ROWS } from '../../src/feed/types.js'

/**
 * An independent in-memory model of the activity feed. It builds every page
 * with a plain loop over the whole ordered list of selectable rows. The
 * integration tests page the real service and compare it with this model, so
 * the two implementations have to agree on selection, order, grouping, where
 * each page ends, the cursor, and how many statements a request needs.
 *
 * The rules, in one place:
 *
 *   - Rows are the selectable records, newest first (ties by URI).
 *   - A group is audio by (owner, folder) or observations by account. Other
 *     kinds, and bioacoustic sightings, stand alone.
 *   - A row joins its group's latest card when it is no more than 12 hours
 *     older than that card's oldest row; otherwise it starts a new card.
 *   - A page takes `limit` cards and stops at the first row that would start
 *     another, or after `requestRows` rows, or at the end of the data.
 *   - A group card of fewer than `MIN_GROUP_ROWS` rows becomes separate
 *     records at their own positions; a group card is placed at its newest row.
 *
 * `groupIndex` numbers the groups of a page in order of appearance, so a test can
 * compare which items belong to one group without knowing the service's keys.
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
      readonly type: 'group'
      readonly kind: 'observation' | 'audio'
      readonly did: string
      readonly deployment: string | null
      readonly total: number
      readonly from: number
      readonly to: number
      readonly subjects: readonly string[]
      readonly groupIndex: number
      readonly more: boolean
    }

/** One page the service must return for a request. */
export interface ModelPage {
  readonly items: readonly ModelItem[]
  /** The AT-URI of every row the page consumed, in item order: the skeleton. */
  readonly uris: readonly string[]
  /** Whether the page has a cursor. */
  readonly hasNext: boolean
  /** How many statements the request needs. */
  readonly statements: number
}

export interface ModelOptions {
  readonly filter: string
  readonly limit: number
  readonly uriRank?: ReadonlyMap<string, number>
  readonly batchRows?: number
  readonly requestRows?: number
}

interface Row {
  readonly record: SeedRecord
  readonly uri: string
  readonly at: number
  readonly kind: string
  /** Position in the whole feed order. */
  readonly index: number
}

const GROUP_GAP_MS = 12 * 60 * 60 * 1000
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

/** What rows share when they group; undefined for a row that stands alone. */
const groupOf = (
  row: Row,
):
  | {
      readonly key: string
      readonly kind: 'observation' | 'audio'
      readonly owner: string
      readonly folder: string | null
    }
  | undefined => {
  if (row.kind === 'audio') {
    const { owner, folder } = audioKey(row.record)
    return {
      key: JSON.stringify(['audio', owner, folder]),
      kind: 'audio',
      owner,
      folder,
    }
  }
  if (row.kind === 'observation' && !isBioacoustic(row.record)) {
    return {
      key: JSON.stringify(['observation', row.record.did, null]),
      kind: 'observation',
      owner: row.record.did,
      folder: null,
    }
  }
  return undefined
}

/**
 * Newest first. Equal timestamps break by URI. The database collation decides
 * what "larger" means for a URI, so tests pass the database's own order; the
 * fallback is plain string order.
 */
const newestFirstBy =
  (uriRank: ReadonlyMap<string, number> | undefined) =>
  (a: Omit<Row, 'index'>, b: Omit<Row, 'index'>): number => {
    if (a.at !== b.at) return b.at - a.at
    if (a.uri === b.uri) return 0
    if (uriRank !== undefined) {
      return (uriRank.get(a.uri) ?? 0) - (uriRank.get(b.uri) ?? 0)
    }
    return a.uri < b.uri ? 1 : -1
  }

/** The selectable rows for a filter, newest first. */
const selectRows = (
  records: readonly SeedRecord[],
  options: Pick<ModelOptions, 'filter' | 'uriRank'>,
): Row[] => {
  const isValid = (record: SeedRecord): boolean =>
    (record.validation ?? 'valid') === 'valid'
  // A repost resolves when its subject is a valid record that would itself be
  // a feed record; the subject's own createdAt only decides whether the
  // subject is in the feed.
  const byUri = new Map(
    records.filter(isValid).map((record) => [uriOf(record), record]),
  )

  const selected: Omit<Row, 'index'>[] = []
  for (const record of records) {
    if (!isValid(record) || !inRange(record.createdAt)) continue
    const kind = kindOf(record)
    if (kind === undefined) continue
    if (options.filter !== 'all' && options.filter !== kind) continue
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
    selected.push({
      record,
      uri: uriOf(record),
      at: Date.parse(record.createdAt ?? ''),
      kind,
    })
  }
  selected.sort(newestFirstBy(options.uriRank))
  return selected.map((row, index) => ({ ...row, index }))
}

/** The AT-URIs of every selectable row, newest first. */
export const modelRowUris = (
  records: readonly SeedRecord[],
  options: Pick<ModelOptions, 'filter' | 'uriRank'>,
): string[] => selectRows(records, options).map((row) => row.uri)

interface Card {
  readonly group: ReturnType<typeof groupOf>
  /** Newest first. */
  readonly rows: Row[]
}

type Stop = 'full' | 'budget' | 'exhausted'

interface Built {
  readonly cards: readonly Card[]
  /** The latest card of each group. */
  readonly latest: ReadonlyMap<string, Card>
  readonly stop: Stop
  /** Index of the first row the page did not consume. */
  readonly end: number
  /** The last row the page consumed; the next page starts after it. */
  readonly last: Row | undefined
}

type PageSizes = Required<
  Pick<ModelOptions, 'limit' | 'batchRows' | 'requestRows'>
>

/** Folds rows into the cards of the page that starts at row `start`. */
const buildPage = (
  rows: readonly Row[],
  start: number,
  sizes: PageSizes,
): Built => {
  const cards: Card[] = []
  const latest = new Map<string, Card>()
  let index = start
  for (;;) {
    if (index - start >= sizes.requestRows) {
      // The service cannot know that no row is left, so it still says "next".
      return {
        cards,
        latest,
        stop: 'budget',
        end: index,
        last: rows[index - 1],
      }
    }
    const row = rows[index]
    if (row === undefined) {
      return {
        cards,
        latest,
        stop: 'exhausted',
        end: index,
        last: rows[index - 1],
      }
    }
    const group = groupOf(row)
    const open = group === undefined ? undefined : latest.get(group.key)
    const oldest = open?.rows.at(-1)
    if (
      open !== undefined &&
      oldest !== undefined &&
      oldest.at - row.at <= GROUP_GAP_MS
    ) {
      open.rows.push(row)
    } else {
      if (cards.length === sizes.limit) {
        return {
          cards,
          latest,
          stop: 'full',
          end: index,
          last: rows[index - 1],
        }
      }
      const card: Card = { group, rows: [row] }
      cards.push(card)
      if (group !== undefined) latest.set(group.key, card)
    }
    index += 1
  }
}

const recordItem = (row: Row): ModelItem =>
  row.kind === 'repost'
    ? {
        type: 'repost',
        uri: row.uri,
        did: row.record.did,
        subject: repostSubjectUri(row.record),
        at: row.at,
      }
    : {
        type: 'record',
        kind: row.kind,
        uri: row.uri,
        did: row.record.did,
        at: row.at,
      }

/**
 * Whether a row after the page could still join the card: the card is the
 * latest of its group, and the last consumed row, which no later row is newer
 * than, is within 12 hours of the card's oldest row. Otherwise the group's
 * next row starts another card.
 */
const continuable = (built: Built, key: string, card: Card): boolean => {
  const oldest = card.rows.at(-1)
  return (
    built.latest.get(key) === card &&
    built.last !== undefined &&
    oldest !== undefined &&
    oldest.at - built.last.at <= GROUP_GAP_MS
  )
}

/** The items of a built page, with the rows each one covers. */
const itemsOf = (built: Built): { items: ModelItem[]; uris: string[] } => {
  const groupIndexes = new Map<string, number>()
  const groupIndexOf = (key: string): number => {
    let index = groupIndexes.get(key)
    if (index === undefined) {
      index = groupIndexes.size
      groupIndexes.set(key, index)
    }
    return index
  }

  const placed: { at: number; item: ModelItem; uris: string[] }[] = []
  for (const card of built.cards) {
    const { group } = card
    const newest = card.rows[0]
    const oldest = card.rows.at(-1)
    if (newest === undefined || oldest === undefined) {
      throw new Error('A card has at least one row.')
    }
    if (group === undefined || card.rows.length < MIN_GROUP_ROWS) {
      for (const row of card.rows) {
        placed.push({ at: row.index, item: recordItem(row), uris: [row.uri] })
      }
      continue
    }
    // The recordings group by `folder` whatever it holds, but the item names
    // it only when it is a valid AT-URI: `deployment` is `format: at-uri`.
    const deployment =
      group.folder !== null && isAtUriString(group.folder) ? group.folder : null
    placed.push({
      at: newest.index,
      item: {
        type: 'group',
        kind: group.kind,
        did: group.owner,
        deployment,
        total: card.rows.length,
        from: oldest.at,
        to: newest.at,
        subjects: card.rows.slice(0, GROUP_SAMPLE_SIZE).map((row) => row.uri),
        groupIndex: groupIndexOf(group.key),
        more: built.stop === 'budget' && continuable(built, group.key, card),
      },
      uris: card.rows.map((row) => row.uri),
    })
  }
  placed.sort((a, b) => a.at - b.at)
  return {
    items: placed.map(({ item }) => item),
    uris: placed.flatMap(({ uris }) => uris),
  }
}

/**
 * Every page of the feed for a request with this `limit`, from the first page
 * to the one without a cursor.
 *
 * A request fetches batches of `batchRows` rows. It needs the batch that holds
 * the first row the page does not take, or every batch up to the row budget,
 * or one more than the data fills.
 */
export const modelPages = (
  records: readonly SeedRecord[],
  options: ModelOptions,
): ModelPage[] => {
  const rows = selectRows(records, options)
  const sizes: PageSizes = {
    limit: options.limit,
    batchRows: options.batchRows ?? BATCH_ROWS,
    requestRows: options.requestRows ?? REQUEST_ROWS,
  }
  const pages: ModelPage[] = []
  let start = 0
  for (;;) {
    const built = buildPage(rows, start, sizes)
    const consumed = built.end - start
    const { items, uris } = itemsOf(built)
    pages.push({
      items,
      uris,
      hasNext: built.stop !== 'exhausted',
      statements:
        built.stop === 'budget'
          ? Math.ceil(sizes.requestRows / sizes.batchRows)
          : Math.floor(consumed / sizes.batchRows) + 1,
    })
    if (built.stop === 'exhausted') return pages
    start = built.end
  }
}
