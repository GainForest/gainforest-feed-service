import { readFileSync } from 'node:fs'

import type { QueryResultRow } from 'pg'

import { timestampUriCursor, type FeedCursor } from './cursor.js'
import { FeedError, FeedErrorCode } from './errors.js'
import { PageBuilder, type FeedRow } from './page-builder.js'
import type { RegisteredFeed } from './registry.js'
import {
  defineSqlFeed,
  type FeedPosition,
  type SelectedPage,
  type SqlFeedQueryExecutor,
  type SqlFeedRuntime,
} from './sql-feed.js'
import {
  ACTIVITY_FEED_ID,
  ACTIVITY_FEED_PARAMS_TYPE,
  type ActivityFeedParams,
  type ActivityFilter,
  type NormalizedActivityRequest,
} from './types.js'
import { normalizeActivityRequest } from './validation.js'
import { activityFeedParams as activityFeedParamsSchema } from '../lexicons/app/gainforest/feed/defs.js'

const ACTIVITY_FEED_QUERY = readFileSync(
  new URL('./feed-query.sql', import.meta.url),
  'utf8',
)

/** Rows one statement returns. */
export const BATCH_ROWS = 500

/**
 * Rows one request consumes at most, so a request runs at most ten statements.
 * A page that reaches it ends there, whatever it holds, and says `more` on the
 * group cards that a later row can still join.
 */
export const REQUEST_ROWS = 5_000

/** Internal options for the activity feed; they are not part of any request. */
export interface ActivityFeedOptions {
  /**
   * Rows one statement returns. Tests use a small value to exercise batching
   * on small data sets; production uses `BATCH_ROWS`.
   */
  readonly batchRows?: number
  /**
   * Rows one request consumes at most. Tests use a small value to reach the
   * budget on small data sets; production uses `REQUEST_ROWS`.
   */
  readonly requestRows?: number
}

interface RowLimits {
  readonly batchRows: number
  readonly requestRows: number
}

const ALL_KINDS = [
  'project',
  'observation',
  'organization',
  'post',
  'repost',
  'audio',
] as const

/** One result row of the activity feed statement: one feed row. */
export interface ActivityFeedQueryRow extends QueryResultRow {
  readonly kind: string
  readonly uri: string
  readonly cid: string | null
  readonly did: string
  readonly sort_value: string
  readonly owner: string | null
  readonly folder: string | null
  readonly bioacoustic: boolean
  readonly subject: string | null
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

  // The generated parser applies the Lexicon default for filter. Only the
  // properties the feed defines are kept: the Lexicon object is open, so any
  // other property the caller sends is dropped here, never read.
  return {
    $type: ACTIVITY_FEED_PARAMS_TYPE,
    filter: parsed.filter,
  }
}

const bindActivityFeed = (
  params: NormalizedActivityRequest,
  after: FeedPosition | undefined,
  rows: number,
): readonly unknown[] => [
  kindsForFilter(params.filter),
  after?.sortValue ?? null,
  after?.uri ?? null,
  rows,
]

/**
 * createdAt in microseconds since the epoch, from the statement's
 * `YYYY-MM-DDTHH:MI:SS.UUUUUUZ`. The fraction is read apart, so a gap of
 * exactly 12 hours is exact to the microsecond.
 */
const microsOf = (uri: string, sortValue: string): number => {
  const seconds = Date.parse(`${sortValue.slice(0, 19)}Z`)
  const fraction = Number(sortValue.slice(20, 26))
  if (!Number.isFinite(seconds) || !Number.isFinite(fraction)) {
    throw rowInvariantError(`row ${uri} has the unreadable time ${sortValue}`)
  }
  return seconds * 1_000 + fraction
}

/** Maps one statement row to a feed row, checking what its kind must have. */
const toFeedRow = (row: ActivityFeedQueryRow): FeedRow => {
  const base = {
    uri: row.uri,
    cid: row.cid,
    did: row.did,
    sortValue: row.sort_value,
    micros: microsOf(row.uri, row.sort_value),
  }
  switch (row.kind) {
    case 'project':
    case 'organization':
    case 'post':
      return { ...base, kind: row.kind }
    case 'observation':
      return { ...base, kind: row.kind, bioacoustic: row.bioacoustic }
    case 'audio':
      if (row.owner === null) {
        throw rowInvariantError(`recording ${row.uri} has no owner`)
      }
      return { ...base, kind: row.kind, owner: row.owner, folder: row.folder }
    case 'repost':
      if (row.subject === null) {
        throw rowInvariantError(`repost ${row.uri} has no subject`)
      }
      return { ...base, kind: row.kind, subject: row.subject }
    default:
      throw rowInvariantError(`row ${row.uri} has unknown kind ${row.kind}`)
  }
}

/**
 * Builds one page: fetches batches of rows after the cursor and folds them
 * into cards until the page is full, the data ends, or the request has
 * consumed its row budget. Each statement starts after the last consumed row.
 */
const selectActivityPage = async (
  database: SqlFeedQueryExecutor<ActivityFeedQueryRow>,
  input: {
    readonly params: NormalizedActivityRequest
    readonly cursor: FeedCursor | undefined
  },
  limits: RowLimits,
): Promise<SelectedPage> => {
  const page = new PageBuilder(input.params.limit)
  let after: FeedPosition | undefined =
    input.cursor === undefined
      ? undefined
      : { sortValue: input.cursor.value, uri: input.cursor.uri }
  let consumed = 0
  for (;;) {
    const wanted = Math.min(limits.batchRows, limits.requestRows - consumed)
    const { rows } = await database.query(
      ACTIVITY_FEED_QUERY,
      bindActivityFeed(input.params, after, wanted),
    )
    for (const row of rows) {
      if (!page.accept(toFeedRow(row))) return page.finish('full')
    }
    consumed += rows.length
    if (rows.length < wanted) return page.finish('exhausted')
    if (consumed >= limits.requestRows) return page.finish('budget')
    after = page.last
  }
}

const validateRowLimit = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer of at least 1.`)
  }
}

/** Builds the GainForest activity feed over one read-only Hyperindex SQL runtime. */
export const createActivityFeed = (
  runtime: SqlFeedRuntime<ActivityFeedQueryRow>,
  options: ActivityFeedOptions = {},
): RegisteredFeed => {
  const limits = {
    batchRows: options.batchRows ?? BATCH_ROWS,
    requestRows: options.requestRows ?? REQUEST_ROWS,
  }
  validateRowLimit('batchRows', limits.batchRows)
  validateRowLimit('requestRows', limits.requestRows)
  return defineSqlFeed(runtime, {
    id: ACTIVITY_FEED_ID,
    params: {
      type: ACTIVITY_FEED_PARAMS_TYPE,
      parse: parseActivityFeedParams,
      normalize: normalizeActivityRequest,
      default: { $type: ACTIVITY_FEED_PARAMS_TYPE },
    },
    cursor: timestampUriCursor,
    select: (database, input) => selectActivityPage(database, input, limits),
  })
}
