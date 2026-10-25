import { isValidDid } from '@atproto/syntax'

import { FeedError, FeedErrorCode } from './errors.js'
import type { FeedPagination } from './registry.js'
import {
  ACTIVITY_FILTERS,
  type ActivityFeedParams,
  type ActivityFilter,
  type NormalizedActivityRequest,
} from './types.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const FILTER_SET = new Set<string>(ACTIVITY_FILTERS)

const isActivityFilter = (value: string): value is ActivityFilter =>
  FILTER_SET.has(value)

const invalidFeedParams = (message: string): FeedError =>
  new FeedError(FeedErrorCode.InvalidRequest, message, 422)

/** Normalizes activity feed params with the shared pagination controls. */
export const normalizeActivityRequest = (
  input: ActivityFeedParams,
  pagination: FeedPagination = {},
): NormalizedActivityRequest => {
  const filter = input.filter ?? 'all'
  if (!isActivityFilter(filter)) {
    throw invalidFeedParams(
      `filter ${JSON.stringify(filter)} is not supported; use one of: ${ACTIVITY_FILTERS.join(', ')}.`,
    )
  }

  const following = input.following ?? false
  const viewerDid = input.viewerDid
  if (viewerDid !== undefined && !isValidDid(viewerDid)) {
    throw invalidFeedParams(
      'viewerDid is not a valid DID; provide the viewer account as a syntactically valid DID.',
    )
  }
  if (following && viewerDid === undefined) {
    throw invalidFeedParams(
      'following requires a viewer; send a service-auth bearer token or provide params.viewerDid, then retry.',
    )
  }

  const limit = pagination.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalidFeedParams(
      `limit must be an integer from 1 through ${String(MAX_LIMIT)}; change limit to a value in that range.`,
    )
  }

  return {
    filter,
    following,
    ...(following && viewerDid !== undefined ? { viewerDid } : {}),
    limit,
    ...(pagination.cursor === undefined ? {} : { cursor: pagination.cursor }),
  }
}
