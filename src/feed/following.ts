import { readFileSync } from 'node:fs'

import { timestampUriCursor } from './cursor.js'
import { FeedError, FeedErrorCode } from './errors.js'
import {
  BATCH_ROWS,
  REQUEST_ROWS,
  kindsForFilter,
  selectBatchedPage,
  validateRowLimit,
  type ActivityFeedOptions,
  type ActivityFeedQueryRow,
} from './query.js'
import type { RegisteredFeed } from './registry.js'
import {
  defineSqlFeed,
  type FeedPosition,
  type SqlFeedRuntime,
} from './sql-feed.js'
import {
  FOLLOWING_FEED_ID,
  FOLLOWING_FEED_PARAMS_TYPE,
  type FollowingFeedParams,
  type NormalizedFollowingRequest,
} from './types.js'
import { normalizeFollowingRequest } from './validation.js'
import { followingFeedParams as followingFeedParamsSchema } from '../lexicons/app/gainforest/feed/defs.js'

const FOLLOWING_FEED_QUERY = readFileSync(
  new URL('./following-query.sql', import.meta.url),
  'utf8',
)

/**
 * Most followed accounts one statement reads. A viewer who follows more gets
 * the accounts followed most recently (an account counts once). Every
 * statement does a few index reads per followed account and kind, so this
 * bounds what it reads for the followed accounts, however many the viewer
 * follows: an anonymous caller may name any account as the viewer. It does not
 * bound reading the viewer's follow records, which the statement reads in full
 * and which is linear in how many there are (about 100 ms at 30,000 records,
 * 200 ms at 100,000).
 */
export const MAX_FOLLOWED_ACCOUNTS = 500

/** Internal options for the following feed; they are not part of any request. */
export interface FollowingFeedOptions extends ActivityFeedOptions {
  /**
   * Followed accounts one statement reads. Tests use a small value to reach
   * the cap with few records; production uses `MAX_FOLLOWED_ACCOUNTS`.
   */
  readonly maxFollowedAccounts?: number
}

const parseFollowingFeedParams = (input: {
  readonly $type: string
}): FollowingFeedParams => {
  let parsed: ReturnType<typeof followingFeedParamsSchema.schema.$parse>
  try {
    parsed = followingFeedParamsSchema.schema.$parse(input)
  } catch (cause) {
    const detail =
      cause instanceof Error && cause.message !== '' ? `: ${cause.message}` : ''
    throw new FeedError(
      FeedErrorCode.InvalidRequest,
      `params does not match ${FOLLOWING_FEED_PARAMS_TYPE}${detail}; correct the feed parameters and retry.`,
      400,
      { cause },
    )
  }

  // The generated parser applies the Lexicon default for filter. Only the
  // properties the feed defines are kept: the Lexicon object is open, so any
  // other property the caller sends is dropped here, never read.
  return {
    $type: FOLLOWING_FEED_PARAMS_TYPE,
    filter: parsed.filter,
    ...(parsed.viewerDid === undefined ? {} : { viewerDid: parsed.viewerDid }),
  }
}

/** The fixed bind order of `following-query.sql`. */
const bindFollowingFeed = (
  params: NormalizedFollowingRequest,
  after: FeedPosition | undefined,
  rows: number,
  maxFollowedAccounts: number,
): readonly unknown[] => [
  kindsForFilter(params.filter),
  after?.sortValue ?? null,
  after?.uri ?? null,
  rows,
  params.viewerDid,
  maxFollowedAccounts,
]

/**
 * Builds the GainForest following feed over one read-only Hyperindex SQL
 * runtime. It pages with the activity feed's batch loop and page builder; only
 * the statement differs.
 */
export const createFollowingFeed = (
  runtime: SqlFeedRuntime<ActivityFeedQueryRow>,
  options: FollowingFeedOptions = {},
): RegisteredFeed => {
  const limits = {
    batchRows: options.batchRows ?? BATCH_ROWS,
    requestRows: options.requestRows ?? REQUEST_ROWS,
  }
  const maxFollowedAccounts =
    options.maxFollowedAccounts ?? MAX_FOLLOWED_ACCOUNTS
  validateRowLimit('batchRows', limits.batchRows)
  validateRowLimit('requestRows', limits.requestRows)
  validateRowLimit('maxFollowedAccounts', maxFollowedAccounts)
  return defineSqlFeed(runtime, {
    id: FOLLOWING_FEED_ID,
    metricName: 'following',
    // No default: the feed needs a viewer, and only the API layer can fill in
    // the verified caller. A request without params is not a global feed.
    params: {
      type: FOLLOWING_FEED_PARAMS_TYPE,
      parse: parseFollowingFeedParams,
      normalize: normalizeFollowingRequest,
    },
    cursor: timestampUriCursor,
    select: (database, input) =>
      selectBatchedPage(
        database,
        {
          text: FOLLOWING_FEED_QUERY,
          bind: (after, rows) =>
            bindFollowingFeed(input.params, after, rows, maxFollowedAccounts),
        },
        { limit: input.params.limit, cursor: input.cursor },
        limits,
      ),
  })
}
