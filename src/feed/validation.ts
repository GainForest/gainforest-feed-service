import { isValidDid } from '@atproto/syntax'

import { FeedError, FeedErrorCode } from './errors.js'
import type { FeedPagination } from './registry.js'
import {
  FEED_KINDS,
  ORGANIZATION_QUALITIES,
  type HypercertsFeedParams,
  type FeedKind,
  type NormalizedFeedRequest,
  type OrganizationQuality,
} from './types.js'

const MAX_EVALUATORS = 64
const MAX_KINDS = 16
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const FEED_KIND_SET = new Set<string>(FEED_KINDS)
const QUALITY_SET = new Set<string>(ORGANIZATION_QUALITIES)

const isOrganizationQuality = (value: string): value is OrganizationQuality =>
  QUALITY_SET.has(value)

const isFeedKind = (value: string): value is FeedKind =>
  FEED_KIND_SET.has(value)

const invalidFeedParams = (message: string): FeedError =>
  new FeedError(FeedErrorCode.InvalidRequest, message, 422)

const dedupe = <T>(values: readonly T[] | undefined): T[] => [
  ...new Set(values ?? []),
]

const validateEvaluatorDids = (values: readonly string[]): void => {
  const invalidIndex = values.findIndex((did) => !isValidDid(did))
  if (invalidIndex !== -1) {
    throw invalidFeedParams(
      `trustedEvaluators[${String(invalidIndex)}] is not a valid DID; replace it with a valid did:plc, did:web, or other syntactically valid DID.`,
    )
  }
}

/** Normalizes Hypercerts params with the shared pagination controls. */
export const normalizeFeedRequest = (
  input: HypercertsFeedParams,
  pagination: FeedPagination = {},
): NormalizedFeedRequest => {
  const viewerDid = input.viewerDid
  if (typeof viewerDid !== 'string' || !isValidDid(viewerDid)) {
    throw invalidFeedParams(
      'viewerDid is not a valid DID; provide the viewer account as a syntactically valid DID.',
    )
  }

  const trustedEvaluators = dedupe(input.trustedEvaluators)
  validateEvaluatorDids(trustedEvaluators)
  if (trustedEvaluators.length > MAX_EVALUATORS) {
    throw invalidFeedParams(
      `trustedEvaluators contains ${String(trustedEvaluators.length)} unique DIDs, exceeding the maximum of ${String(MAX_EVALUATORS)}; remove evaluators before retrying.`,
    )
  }

  const rawKinds = dedupe(input.kinds)
  if (rawKinds.length > MAX_KINDS) {
    throw invalidFeedParams(
      `kinds contains ${String(rawKinds.length)} unique values, exceeding the maximum of ${String(MAX_KINDS)}; request at most ${String(MAX_KINDS)} supported kinds.`,
    )
  }
  const unknownKind = rawKinds.find((kind) => !isFeedKind(kind))
  if (unknownKind !== undefined) {
    throw invalidFeedParams(
      `kinds contains unsupported value ${JSON.stringify(unknownKind)}; use one of: ${FEED_KINDS.join(', ')}.`,
    )
  }

  const rawQuality = input.organizationQuality
  let organizationQuality: NormalizedFeedRequest['organizationQuality']
  if (rawQuality) {
    const allowed = dedupe(rawQuality.allowed)
    const invalidQuality = allowed.find(
      (quality) => !isOrganizationQuality(quality),
    )
    if (invalidQuality !== undefined) {
      throw invalidFeedParams(
        `organizationQuality.allowed contains unsupported value ${JSON.stringify(invalidQuality)}; use one of: ${ORGANIZATION_QUALITIES.join(', ')}.`,
      )
    }
    organizationQuality = {
      allowed: allowed.filter(isOrganizationQuality),
      includeUnrated: rawQuality.includeUnrated,
    }
  }

  const limit = pagination.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalidFeedParams(
      `limit must be an integer from 1 through ${String(MAX_LIMIT)}; change limit to a value in that range.`,
    )
  }

  return {
    viewerDid,
    trustedEvaluators,
    ...(organizationQuality ? { organizationQuality } : {}),
    limit,
    kinds: rawKinds.filter(isFeedKind),
    ...(pagination.cursor !== undefined ? { cursor: pagination.cursor } : {}),
  }
}
