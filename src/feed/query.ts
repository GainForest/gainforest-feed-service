import { readFileSync } from 'node:fs'

import type { QueryResultRow } from 'pg'

import { timestampUriCursor, type FeedCursor } from './cursor.js'
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
import { QUERY_CANCELED, sqlState } from '../sql-state.js'
import { activityFeedParams as activityFeedParamsSchema } from '../lexicons/app/gainforest/feed/defs.js'

const ACTIVITY_FEED_QUERY = readFileSync(
  new URL('./feed-query.sql', import.meta.url),
  'utf8',
)

/** Longest gap between neighbouring observations inside one burst. */
const BURST_MAX_GAP_SECONDS = 12 * 60 * 60

/** Most sample URIs a burst or an audio day references. */
const SAMPLE_SIZE = 20

/**
 * How many rows of the merged feed order the statement may read. The statement
 * reports `complete = false` when a long burst or audio day needs more, and
 * the query is repeated with the next value.
 */
const DEFAULT_SCAN_ROW_ATTEMPTS: readonly number[] = [
  512, 8_192, 131_072, 2_097_152,
]

/** Internal options for the activity feed; they are not part of any request. */
export interface ActivityFeedOptions {
  /**
   * The scan windows to try, smallest first. Tests use tiny windows to force
   * the retry path; production uses the default.
   */
  readonly scanRowAttempts?: readonly number[]
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

/** One result row of the activity feed statement: one feed item, or the page-level flag alone. */
export interface ActivityFeedQueryRow extends QueryResultRow {
  readonly complete: boolean
  readonly item_no: number | null
  readonly kind: string | null
  readonly uri: string | null
  readonly cid: string | null
  readonly did: string | null
  readonly sort_value: string | null
  readonly subject: string | null
  readonly deployment: string | null
  readonly day: string | null
  readonly total: number | null
  readonly tail_sort_value: string | null
  readonly tail_uri: string | null
  readonly samples: readonly string[] | null
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

const bindActivityFeed = (
  params: NormalizedActivityRequest,
  cursor: FeedCursor | undefined,
  scanRows: number,
): readonly unknown[] => [
  kindsForFilter(params.filter),
  params.following,
  params.viewerDid ?? null,
  cursor?.value ?? null,
  cursor?.uri ?? null,
  params.limit + 1,
  scanRows,
  BURST_MAX_GAP_SECONDS,
  SAMPLE_SIZE,
]

interface ItemRow extends ActivityFeedQueryRow {
  readonly kind: string
  readonly uri: string
  readonly did: string
  readonly sort_value: string
  readonly tail_sort_value: string
  readonly tail_uri: string
}

const isItemRow = (row: ActivityFeedQueryRow): row is ItemRow =>
  row.item_no !== null

const optionalCid = (row: ItemRow): { readonly cid?: string } =>
  row.cid === null ? {} : { cid: row.cid }

const samplesOf = (row: ItemRow): readonly string[] => {
  if (row.samples === null || row.samples.length === 0) {
    throw rowInvariantError(`item ${row.uri} returned no sample URIs`)
  }
  return row.samples
}

const mapItem = (row: ItemRow): ActivityFeedItem => {
  switch (row.kind) {
    case 'repost':
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
    case 'audio':
      if (row.day === null || row.total === null) {
        throw rowInvariantError(`audio group ${row.uri} has no day or total`)
      }
      return {
        $type: AUDIO_ITEM_TYPE,
        did: row.did,
        day: row.day,
        ...(row.deployment === null ? {} : { deployment: row.deployment }),
        total: row.total,
        createdAt: row.sort_value,
        subjects: samplesOf(row),
      }
    case 'observation':
      if (row.total !== null && row.total > 1) {
        return {
          $type: BURST_ITEM_TYPE,
          did: row.did,
          total: row.total,
          from: row.tail_sort_value,
          to: row.sort_value,
          subjects: samplesOf(row),
        }
      }
      return recordItem(row, 'observation')
    default:
      if (isRecordItemKind(row.kind)) return recordItem(row, row.kind)
      throw rowInvariantError(`item ${row.uri} has unknown kind ${row.kind}`)
  }
}

const recordItem = (row: ItemRow, kind: RecordItemKind): ActivityFeedItem => ({
  $type: RECORD_ITEM_TYPE,
  kind,
  uri: row.uri,
  ...optionalCid(row),
  did: row.did,
  createdAt: row.sort_value,
})

const toSelectedItem = (row: ItemRow): SelectedItem => ({
  item: mapItem(row),
  position: { sortValue: row.tail_sort_value, uri: row.tail_uri },
})

/**
 * The typed, non-retryable failure for a page that cannot be produced without
 * splitting one account's run. It depends on the data, not on the request.
 */
const scanLimitExceeded = (detail: string, options?: ErrorOptions): FeedError =>
  new FeedError(
    FeedErrorCode.ScanLimitExceeded,
    `${detail} Retrying the same request will not help; the feed cannot be paged past this run until the operator investigates the account's activity.`,
    422,
    options,
  )

/**
 * Runs the feed statement, widening the scanned prefix of the merged feed
 * order until the statement reports a complete page.
 *
 * A statement timeout on the first window is a real outage and stays a plain
 * failure. A statement timeout on a wider window means the run is too long to
 * group in time, which is the same condition as running out of windows: that
 * is the typed `ScanLimitExceeded` error, not a generic 500.
 */
const selectActivityPage = async (
  database: SqlFeedQueryExecutor<ActivityFeedQueryRow>,
  input: {
    readonly params: NormalizedActivityRequest
    readonly cursor: FeedCursor | undefined
  },
  scanRowAttempts: readonly number[],
): Promise<SelectedPage> => {
  for (const [attempt, scanRows] of scanRowAttempts.entries()) {
    let rows: readonly ActivityFeedQueryRow[]
    try {
      ;({ rows } = await database.query(
        ACTIVITY_FEED_QUERY,
        bindActivityFeed(input.params, input.cursor, scanRows),
      ))
    } catch (cause) {
      const previousWindow = scanRowAttempts[attempt - 1]
      if (previousWindow !== undefined && sqlState(cause) === QUERY_CANCELED) {
        throw scanLimitExceeded(
          `This page needs more than ${String(previousWindow)} rows of the merged feed order to group one account's run of observations or recordings, and reading ${String(scanRows)} rows did not finish within the database statement timeout.`,
          { cause },
        )
      }
      throw cause
    }
    const first = rows[0]
    if (first === undefined) {
      throw rowInvariantError('the statement returned no rows')
    }
    if (!first.complete) continue

    const itemRows = rows.filter(isItemRow)
    return {
      items: itemRows.slice(0, input.params.limit).map(toSelectedItem),
      hasNext: itemRows.length > input.params.limit,
    }
  }
  throw scanLimitExceeded(
    `This page needs more than ${String(scanRowAttempts.at(-1))} rows of the merged feed order to group one account's run of observations or recordings, which is more than this service reads.`,
  )
}

const validateScanRowAttempts = (attempts: readonly number[]): void => {
  const valid =
    attempts.length > 0 &&
    attempts.every(
      (rows, index) =>
        Number.isSafeInteger(rows) &&
        rows > 0 &&
        (index === 0 || rows > (attempts[index - 1] ?? 0)),
    )
  if (!valid) {
    throw new Error(
      'scanRowAttempts must be a non-empty, strictly increasing list of positive integers.',
    )
  }
}

/** Builds the GainForest activity feed over one read-only Hyperindex SQL runtime. */
export const createActivityFeed = (
  runtime: SqlFeedRuntime<ActivityFeedQueryRow>,
  options: ActivityFeedOptions = {},
): RegisteredFeed => {
  const scanRowAttempts = options.scanRowAttempts ?? DEFAULT_SCAN_ROW_ATTEMPTS
  validateScanRowAttempts(scanRowAttempts)
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
      selectActivityPage(database, input, scanRowAttempts),
  })
}
