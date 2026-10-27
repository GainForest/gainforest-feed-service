import { FeedError, FeedErrorCode } from '../feed/errors.js'
import {
  FOLLOWING_FEED_ID,
  FOLLOWING_FEED_PARAMS_TYPE,
  type FeedParams,
  type FeedRequest,
  type FollowingFeedParams,
} from '../feed/types.js'
import type { ServiceAuthCredentials } from './service-auth.js'

const isFollowingFeedParams = (
  params: FeedParams,
): params is FollowingFeedParams => params.$type === FOLLOWING_FEED_PARAMS_TYPE

/**
 * Names the viewer of a following feed request. Only `#followingFeed` has a
 * viewer; every other feed, the activity feed included, gives every caller the
 * same page and is returned untouched.
 *
 * An authenticated request is for the verified caller: `viewerDid` may be
 * omitted, and a value that names anyone else is rejected, so a signed-in
 * caller cannot read another account's following feed. An anonymous request
 * has no identity to fall back on and has to name the viewer itself.
 * `acceptsToken` is whether this service verifies service-auth tokens at all:
 * when it does not, the error for a missing viewer must not suggest sending one.
 */
export const applyAuthenticatedViewer = (
  input: FeedRequest,
  credentials: ServiceAuthCredentials | undefined,
  acceptsToken = true,
): FeedRequest => {
  if (input.feedId !== FOLLOWING_FEED_ID) return input
  const params = input.params
  // Params of another feed's type are left for the registry to reject.
  if (params !== undefined && !isFollowingFeedParams(params)) return input

  if (credentials === undefined) {
    if (params?.viewerDid === undefined) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        acceptsToken
          ? 'params.viewerDid is required for an anonymous following feed request; provide the viewer DID in followingFeedParams or send a valid service-auth bearer token, then retry.'
          : 'params.viewerDid is required for a following feed request; provide the viewer DID in followingFeedParams and retry.',
      )
    }
    return input
  }

  if (params?.viewerDid !== undefined && params.viewerDid !== credentials.did) {
    throw new FeedError(
      FeedErrorCode.InvalidRequest,
      'params.viewerDid does not match the authenticated service caller; omit viewerDid or use the authenticated viewer DID and retry.',
    )
  }

  return {
    ...input,
    params: {
      $type: FOLLOWING_FEED_PARAMS_TYPE,
      ...(params?.filter === undefined ? {} : { filter: params.filter }),
      viewerDid: credentials.did,
    },
  }
}
