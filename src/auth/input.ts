import { FeedError, FeedErrorCode } from '../feed/errors.js'
import {
  HYPERCERTS_FEED_PARAMS_TYPE,
  type FeedParams,
  type HypercertsFeedParams,
  type GetFeedSkeletonInput,
} from '../feed/types.js'
import type { ServiceAuthCredentials } from './service-auth.js'

/**
 * Applies the verified caller DID to the internal feed request. The body may
 * omit viewerDid only for authenticated requests; a supplied value is checked
 * before it is replaced by the verified identity.
 */
const isHypercertsFeedParams = (
  params: FeedParams | undefined,
): params is HypercertsFeedParams =>
  params?.$type === HYPERCERTS_FEED_PARAMS_TYPE

export const applyAuthenticatedViewer = (
  input: GetFeedSkeletonInput,
  credentials: ServiceAuthCredentials | undefined,
): GetFeedSkeletonInput => {
  const params = input.params
  if (!isHypercertsFeedParams(params)) return input
  const hypercertsParams = params

  if (credentials === undefined) {
    if (hypercertsParams.viewerDid === undefined) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        'params.viewerDid is required for anonymous requests; provide the viewer DID or send a valid service-auth bearer token and retry.',
      )
    }
    return input
  }

  if (
    hypercertsParams.viewerDid !== undefined &&
    hypercertsParams.viewerDid !== credentials.did
  ) {
    throw new FeedError(
      FeedErrorCode.InvalidRequest,
      'params.viewerDid does not match the authenticated service caller; omit viewerDid or use the authenticated viewer DID and retry.',
    )
  }

  return {
    ...input,
    params: {
      ...hypercertsParams,
      viewerDid: credentials.did,
    },
  }
}
