import { FeedError, FeedErrorCode } from '../feed/errors.js'
import {
  ACTIVITY_FEED_PARAMS_TYPE,
  type ActivityFeedParams,
  type FeedParams,
  type FeedRequest,
} from '../feed/types.js'
import type { ServiceAuthCredentials } from './service-auth.js'

const isActivityFeedParams = (
  params: FeedParams | undefined,
): params is ActivityFeedParams => params?.$type === ACTIVITY_FEED_PARAMS_TYPE

/**
 * Applies the verified caller DID to the internal feed request. The body may
 * omit viewerDid when the request is authenticated; a supplied value is
 * checked against the verified identity before it is replaced by it.
 * Anonymous requests need a viewerDid only when they ask for the following
 * feed.
 */
export const applyAuthenticatedViewer = (
  input: FeedRequest,
  credentials: ServiceAuthCredentials | undefined,
): FeedRequest => {
  const params = input.params
  if (!isActivityFeedParams(params)) return input

  if (credentials === undefined) {
    if (params.following === true && params.viewerDid === undefined) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        'params.viewerDid is required for anonymous requests that set following; provide the viewer DID or send a valid service-auth bearer token and retry.',
      )
    }
    return input
  }

  if (params.viewerDid !== undefined && params.viewerDid !== credentials.did) {
    throw new FeedError(
      FeedErrorCode.InvalidRequest,
      'params.viewerDid does not match the authenticated service caller; omit viewerDid or use the authenticated viewer DID and retry.',
    )
  }

  return {
    ...input,
    params: {
      ...params,
      viewerDid: credentials.did,
    },
  }
}
