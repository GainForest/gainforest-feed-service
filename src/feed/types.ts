/** Organization quality categories understood by the Certified Orglabeler policy. */
export const ORGANIZATION_QUALITIES = [
  'high-quality',
  'standard',
  'draft',
  'likely-test',
] as const

/** A quality category that a trusted Orglabeler can assign to an organization. */
export type OrganizationQuality = (typeof ORGANIZATION_QUALITIES)[number]

/** Collections that can produce events in the Hypercerts feed. */
export const FEED_COLLECTIONS = [
  'org.hypercerts.claim.activity',
  'org.hypercerts.collection',
  'org.hypercerts.context.evaluation',
  'org.hypercerts.context.measurement',
  'org.hypercerts.context.attachment',
  'app.certified.badge.award',
] as const

/** Final event classifications exposed by the Hypercerts hydrated view. */
export const FEED_KINDS = [
  'cert.create',
  'collection.create',
  'project.created_with_cert',
  'evaluation.create',
  'measurement.create',
  'update.create',
  'endorsement.award',
] as const

/** A supported interpretation of an indexed source record. */
export type FeedKind = (typeof FEED_KINDS)[number]

/** Account-quality rules applied to known organizations before selecting events. */
export interface OrganizationQualityPolicy {
  /** Quality categories that are allowed to remain in the author scope. */
  readonly allowed: readonly OrganizationQuality[]
  /** Whether a known organization without an active trusted label qualifies. */
  readonly includeUnrated: boolean
}

/** Identifier of the Hypercerts viewer-scope feed algorithm. */
export const HYPERCERTS_FEED_ID =
  'org.hypercerts.feed.defs#hypercertsFeed' as const

/** Open-union discriminator for the Hypercerts feed's parameters. */
export const HYPERCERTS_FEED_PARAMS_TYPE =
  'org.hypercerts.feed.defs#hypercertsFeedParams' as const

/** Raw organization-quality policy accepted before semantic value checks. */
export interface OrganizationQualityPolicyInput {
  readonly allowed: readonly string[]
  readonly includeUnrated: boolean
}

/** Parameters accepted by the Hypercerts viewer-scope feed algorithm. */
export interface HypercertsFeedParams {
  readonly $type: typeof HYPERCERTS_FEED_PARAMS_TYPE
  /** Viewer whose current Certified outbound follows supply the base scope. */
  readonly viewerDid?: string
  /** Evaluators whose active endorsement subjects are added to the base scope. */
  readonly trustedEvaluators?: readonly string[]
  /** Optional organization-quality membership policy. */
  readonly organizationQuality?: OrganizationQualityPolicyInput
  /** Final event-kind filter; omitted or empty means every supported kind. */
  readonly kinds?: readonly string[]
}

/** Discriminator retained when the public open union receives an unknown variant. */
export interface UnknownFeedParams {
  /** Lexicon type that selects the parameter validator for this feed. */
  readonly $type: string
}

/** Parameters for any feed algorithm accepted by the public open union. */
export type FeedParams = HypercertsFeedParams | UnknownFeedParams

/** Raw request body shared by the skeleton and hydrated feed procedures. */
export interface GetFeedSkeletonInput {
  /** Identifier used to select the feed algorithm. */
  readonly feedId: string
  /** Optional algorithm-specific parameters selected by their discriminator. */
  readonly params?: FeedParams
  /** Requested page size; the selected feed owns its default and supported maximum. */
  readonly limit?: number
  /** Opaque cursor returned by an earlier page of this feed. */
  readonly cursor?: string
}

/** One unhydrated record selected for the feed. */
export interface FeedSkeletonItem {
  /** AT-URI of the record that the downstream data plane should hydrate. */
  readonly subject: string
}

/** Public response body from org.hypercerts.feed.getFeedSkeleton. */
export interface GetFeedSkeletonOutput {
  /** Ordered, unhydrated feed records for the current page. */
  readonly feed: readonly FeedSkeletonItem[]
  /** Opaque cursor for a possible later page; absent at the known end. */
  readonly cursor?: string
}

/** Fully validated and deduplicated request passed to the SQL adapter. */
export interface NormalizedFeedRequest {
  /** Validated viewer DID whose current Certified follows supply the base scope. */
  readonly viewerDid: string
  /** Deduplicated evaluator DIDs. */
  readonly trustedEvaluators: readonly string[]
  /** Optional validated account-quality policy. */
  readonly organizationQuality?: OrganizationQualityPolicy
  /** Page size in the inclusive range 1..50. */
  readonly limit: number
  /** Deduplicated final event kinds, empty to select every supported kind. */
  readonly kinds: readonly FeedKind[]
  /** Raw cursor supplied by the caller, if any. */
  readonly cursor?: string
}
