import { isValidDid } from '@atproto/syntax'

import { FeedError, FeedErrorCode } from './errors.js'
import type { FeedPagination } from './registry.js'
import {
  ACTIVITY_FILTERS,
  type ActivityFeedParams,
  type ActivityFilter,
  type FollowingFeedParams,
  type NormalizedActivityRequest,
  type NormalizedFollowingRequest,
} from './types.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const FILTER_SET = new Set<string>(ACTIVITY_FILTERS)

const isActivityFilter = (value: string): value is ActivityFilter =>
  FILTER_SET.has(value)

const invalidFeedParams = (message: string): FeedError =>
  new FeedError(FeedErrorCode.InvalidRequest, message, 422)

const normalizeFilter = (filter: string | undefined): ActivityFilter => {
  const value = filter ?? 'all'
  if (!isActivityFilter(value)) {
    throw invalidFeedParams(
      `filter ${JSON.stringify(value)} is not supported; use one of: ${ACTIVITY_FILTERS.join(', ')}.`,
    )
  }
  return value
}

const normalizeLimit = (pagination: FeedPagination): number => {
  const limit = pagination.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalidFeedParams(
      `limit must be an integer from 1 through ${String(MAX_LIMIT)}; change limit to a value in that range.`,
    )
  }
  return limit
}

/** Normalizes activity feed params with the shared pagination controls. */
export const normalizeActivityRequest = (
  input: ActivityFeedParams,
  pagination: FeedPagination = {},
): NormalizedActivityRequest => ({
  filter: normalizeFilter(input.filter),
  limit: normalizeLimit(pagination),
  ...(pagination.cursor === undefined ? {} : { cursor: pagination.cursor }),
})

/**
 * Normalizes following feed params with the shared pagination controls. The
 * API layer has already replaced `viewerDid` with the verified caller when the
 * request is authenticated, so a missing viewer here is an anonymous request
 * that did not name one.
 */
export const normalizeFollowingRequest = (
  input: FollowingFeedParams,
  pagination: FeedPagination = {},
): NormalizedFollowingRequest => {
  const filter = normalizeFilter(input.filter)
  const viewerDid = input.viewerDid
  if (viewerDid === undefined) {
    throw invalidFeedParams(
      'the following feed needs a viewer; send a service-auth bearer token or provide params.viewerDid, then retry.',
    )
  }
  if (!isValidDid(viewerDid)) {
    throw invalidFeedParams(
      'viewerDid is not a valid DID; provide the viewer account as a syntactically valid DID.',
    )
  }

  return {
    filter,
    viewerDid,
    limit: normalizeLimit(pagination),
    ...(pagination.cursor === undefined ? {} : { cursor: pagination.cursor }),
  }
}
