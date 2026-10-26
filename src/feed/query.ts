import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { isAtUriString } from '@atproto/syntax'
import type { QueryResultRow } from 'pg'

import {
  timestampUriCursor,
  type FeedCursor,
  type OpenGroup,
} from './cursor.js'
import { FeedError, FeedErrorCode } from './errors.js'
import type { RegisteredFeed } from './registry.js'
import {
  defineSqlFeed,
  type SelectedItem,
  type SelectedPage,
  type SqlFeedQueryExecutor,
  type SqlFeedRuntime,
} from './sql-feed.js'
import {
  ACTIVITY_FEED_ID,
  ACTIVITY_FEED_PARAMS_TYPE,
  AUDIO_ITEM_TYPE,
  BURST_ITEM_TYPE,
  MAX_GROUP_ROWS,
  RECORD_ITEM_KINDS,
  RECORD_ITEM_TYPE,
  REPOST_ITEM_TYPE,
  type ActivityFeedItem,
  type ActivityFeedParams,
  type ActivityFilter,
  type NormalizedActivityRequest,
  type RecordItemKind,
} from './types.js'
import { normalizeActivityRequest } from './validation.js'
import { activityFeedParams as activityFeedParamsSchema } from '../lexicons/app/gainforest/feed/defs.js'

const ACTIVITY_FEED_QUERY = readFileSync(
  new URL('./feed-query.sql', import.meta.url),
  'utf8',
)

/** Longest gap between neighbouring rows inside one burst or audio run. */
const BURST_MAX_GAP_SECONDS = 12 * 60 * 60

/** Most sample URIs a burst or an audio item references. */
const SAMPLE_SIZE = 20

/** Internal options for the activity feed; they are not part of any request. */
export interface ActivityFeedOptions {
  /**
   * Most rows one burst or audio item covers. Tests use a small value to
   * exercise chunking on small data sets; production uses `MAX_GROUP_ROWS`.
   */
  readonly maxGroupRows?: number
}

const ALL_KINDS = [
  'project',
  'observation',
  'organization',
  'post',
  'repost',
  'audio',
] as const

const RECORD_KIND_SET = new Set<string>(RECORD_ITEM_KINDS)

const isRecordItemKind = (value: string): value is RecordItemKind =>
  RECORD_KIND_SET.has(value)

/** One result row of the activity feed statement: one feed item. */
export interface ActivityFeedQueryRow extends QueryResultRow {
  readonly item_no: number
  readonly kind: string
  readonly uri: string
  readonly cid: string | null
  readonly did: string
  readonly sort_value: string
  readonly subject: string | null
  readonly deployment: string | null
  /** Rows the item covers. Null for the sentinel, which is never mapped. */
  readonly total: number | null
  readonly tail_sort_value: string | null
  readonly tail_uri: string | null
  readonly samples: readonly string[] | null
  readonly continued: boolean
  readonly capped: boolean
}

const rowInvariantError = (detail: string): Error =>
  new Error(
    `Activity feed query invariant failed: ${detail}; verify the SQL projection before serving feed requests.`,
  )

const kindsForFilter = (filter: ActivityFilter): readonly string[] =>
  filter === 'all' ? ALL_KINDS : [filter]

const parseActivityFeedParams = (input: {
  readonly $type: string
}): ActivityFeedParams => {
  let parsed: ReturnType<typeof activityFeedParamsSchema.schema.$parse>
  try {
    parsed = activityFeedParamsSchema.schema.$parse(input)
  } catch (cause) {
    const detail =
      cause instanceof Error && cause.message !== '' ? `: ${cause.message}` : ''
    throw new FeedError(
      FeedErrorCode.InvalidRequest,
      `params does not match ${ACTIVITY_FEED_PARAMS_TYPE}${detail}; correct the feed parameters and retry.`,
      400,
      { cause },
    )
  }

  // The generated parser applies the Lexicon defaults for filter and following.
  return {
    $type: ACTIVITY_FEED_PARAMS_TYPE,
    filter: parsed.filter,
    following: parsed.following,
    ...(parsed.viewerDid === undefined ? {} : { viewerDid: parsed.viewerDid }),
  }
}

/**
 * Rows the statement reads from the merged feed order for one page.
 *
 * The page's `limit` items cover at most `maxGroupRows` rows each. One more
 * row, the first row of the item after the page, proves that a next page
 * exists and tells whether the page's last chunk continues its run. A row
 * that follows an item is the first row of the next item, so no item needs a
 * lookahead row of its own. Reading this many rows always settles the page in
 * one statement.
 */
const scanRowsFor = (limit: number, maxGroupRows: number): number =>
  limit * maxGroupRows + 1

const bindActivityFeed = (
  params: NormalizedActivityRequest,
  cursor: FeedCursor | undefined,
  maxGroupRows: number,
): readonly unknown[] => [
  kindsForFilter(params.filter),
  params.following,
  params.viewerDid ?? null,
  cursor?.value ?? null,
  cursor?.uri ?? null,
  params.limit + 1,
  scanRowsFor(params.limit, maxGroupRows),
  BURST_MAX_GAP_SECONDS,
  SAMPLE_SIZE,
  maxGroupRows,
  // Only the kind of the open run is bound. The statement reads the run's
  // account and folder from the cursor row, never from the cursor.
  cursor?.group?.kind ?? null,
]

/** The group key of a run: opaque, and derived from the run's newest record. */
const deriveGroupKey = (headUri: string): string =>
  createHash('sha256').update(headUri).digest('base64url').slice(0, 22)

/** An item row with the details the statement computes for the page's own items. */
interface ItemRow extends ActivityFeedQueryRow {
  readonly total: number
  readonly tail_sort_value: string
  readonly tail_uri: string
}

const hasDetails = (row: ActivityFeedQueryRow): row is ItemRow =>
  row.total !== null && row.tail_sort_value !== null && row.tail_uri !== null

const optionalCid = (row: ItemRow): { readonly cid?: string } =>
  row.cid === null ? {} : { cid: row.cid }

/**
 * The folder of an audio item, when the response can name it. `deployment`
 * has `format: at-uri`, and the output check applies the same strict test as
 * `isAtUriString`. One `deploymentRef` that fails it would fail every page
 * that holds the recording with a 500, so such a folder is left out. The
 * recordings still group by it, exactly as before.
 */
const deploymentOf = (row: ItemRow): { readonly deployment?: string } =>
  row.deployment !== null && isAtUriString(row.deployment)
    ? { deployment: row.deployment }
    : {}

const samplesOf = (row: ItemRow): readonly string[] => {
  if (row.samples === null || row.samples.length === 0) {
    throw rowInvariantError(`item ${row.uri} returned no sample URIs`)
  }
  return row.samples
}

/**
 * Audio items are always groups. An observation item is a group when it
 * covers several rows, or when it continues a run: a one-row chunk after a
 * capped chunk stays a burst so that clients merge it into the run's card.
 */
const isGroupRow = (row: ItemRow): boolean =>
  row.kind === 'audio' ||
  (row.kind === 'observation' && (row.total > 1 || row.continued))

const recordItem = (row: ItemRow, kind: RecordItemKind): ActivityFeedItem => ({
  $type: RECORD_ITEM_TYPE,
  kind,
  uri: row.uri,
  ...optionalCid(row),
  did: row.did,
  createdAt: row.sort_value,
})

const groupItem = (row: ItemRow, groupKey: string): ActivityFeedItem => {
  const chunk = {
    did: row.did,
    total: row.total,
    from: row.tail_sort_value,
    to: row.sort_value,
    subjects: samplesOf(row),
    groupKey,
    continued: row.continued,
    capped: row.capped,
  }
  return row.kind === 'audio'
    ? {
        $type: AUDIO_ITEM_TYPE,
        ...chunk,
        ...deploymentOf(row),
      }
    : { $type: BURST_ITEM_TYPE, ...chunk }
}

const mapSingleItem = (row: ItemRow): ActivityFeedItem => {
  if (row.kind === 'repost') {
    if (row.subject === null) {
      throw rowInvariantError(`repost ${row.uri} has no subject`)
    }
    return {
      $type: REPOST_ITEM_TYPE,
      uri: row.uri,
      ...optionalCid(row),
      did: row.did,
      createdAt: row.sort_value,
      subject: row.subject,
    }
  }
  if (isRecordItemKind(row.kind)) return recordItem(row, row.kind)
  throw rowInvariantError(`item ${row.uri} has unknown kind ${row.kind}`)
}

/**
 * Maps the page's own item rows. A chunk after the first one of a run keeps
 * the run's group key: it comes from the previous item, or, for the first
 * item of the page, from the run the cursor left open.
 */
const toSelectedItems = (
  rows: readonly ActivityFeedQueryRow[],
  open: OpenGroup | undefined,
): SelectedItem[] => {
  let previousKey = open?.key
  return rows.map((row) => {
    if (!hasDetails(row)) {
      throw rowInvariantError(`item ${row.uri} has no row count or last row`)
    }
    const position = { sortValue: row.tail_sort_value, uri: row.tail_uri }
    if (!isGroupRow(row)) {
      previousKey = undefined
      return { item: mapSingleItem(row), position }
    }

    if (row.continued && previousKey === undefined) {
      throw rowInvariantError(
        `item ${row.uri} continues a run that neither the previous item nor the cursor names`,
      )
    }
    const groupKey =
      row.continued && previousKey !== undefined
        ? previousKey
        : deriveGroupKey(row.uri)
    previousKey = groupKey

    return {
      item: groupItem(row, groupKey),
      position: {
        ...position,
        // Only a chunk the cap cut can be continued by the next page.
        ...(row.capped
          ? {
              group: {
                key: groupKey,
                kind: row.kind === 'audio' ? 'audio' : 'observation',
              },
            }
          : {}),
      },
    }
  })
}

/**
 * Runs the feed statement once. It returns the page's items and the sentinel
 * item that proves a next page exists.
 */
const selectActivityPage = async (
  database: SqlFeedQueryExecutor<ActivityFeedQueryRow>,
  input: {
    readonly params: NormalizedActivityRequest
    readonly cursor: FeedCursor | undefined
  },
  maxGroupRows: number,
): Promise<SelectedPage> => {
  const { rows } = await database.query(
    ACTIVITY_FEED_QUERY,
    bindActivityFeed(input.params, input.cursor, maxGroupRows),
  )
  return {
    items: toSelectedItems(
      rows.slice(0, input.params.limit),
      input.cursor?.group,
    ),
    hasNext: rows.length > input.params.limit,
  }
}

const validateMaxGroupRows = (maxGroupRows: number): void => {
  // A capped chunk of one row could not be told apart from a lone observation.
  if (!Number.isSafeInteger(maxGroupRows) || maxGroupRows < 2) {
    throw new Error('maxGroupRows must be an integer of at least 2.')
  }
}

/** Builds the GainForest activity feed over one read-only Hyperindex SQL runtime. */
export const createActivityFeed = (
  runtime: SqlFeedRuntime<ActivityFeedQueryRow>,
  options: ActivityFeedOptions = {},
): RegisteredFeed => {
  const maxGroupRows = options.maxGroupRows ?? MAX_GROUP_ROWS
  validateMaxGroupRows(maxGroupRows)
  return defineSqlFeed(runtime, {
    id: ACTIVITY_FEED_ID,
    params: {
      type: ACTIVITY_FEED_PARAMS_TYPE,
      parse: parseActivityFeedParams,
      normalize: normalizeActivityRequest,
      default: { $type: ACTIVITY_FEED_PARAMS_TYPE },
    },
    cursor: timestampUriCursor,
    select: (database, input) =>
      selectActivityPage(database, input, maxGroupRows),
  })
}
