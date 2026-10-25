/** Identifier of the GainForest activity feed algorithm. */
export const ACTIVITY_FEED_ID = 'app.gainforest.feed.defs#activityFeed' as const

/** Open-union discriminator for the activity feed's parameters. */
export const ACTIVITY_FEED_PARAMS_TYPE =
  'app.gainforest.feed.defs#activityFeedParams' as const

/** Values accepted by the activity feed's `filter` parameter. */
export const ACTIVITY_FILTERS = [
  'all',
  'project',
  'observation',
  'organization',
  'post',
  'audio',
] as const

/** Which kind of activity the feed includes. */
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]

/** Kinds of record that become a single `recordItem`. */
export const RECORD_ITEM_KINDS = [
  'project',
  'observation',
  'organization',
  'post',
] as const

/** Which kind of record a `recordItem` points at. */
export type RecordItemKind = (typeof RECORD_ITEM_KINDS)[number]

/** Wire discriminators for the feed item union. */
export const RECORD_ITEM_TYPE = 'app.gainforest.feed.defs#recordItem' as const
export const REPOST_ITEM_TYPE = 'app.gainforest.feed.defs#repostItem' as const
export const BURST_ITEM_TYPE = 'app.gainforest.feed.defs#burstItem' as const
export const AUDIO_ITEM_TYPE = 'app.gainforest.feed.defs#audioItem' as const

/** Bounded metric label for one feed item. */
export type FeedItemKind = RecordItemKind | 'repost' | 'burst' | 'audio'

/** Parameters accepted by the activity feed. */
export interface ActivityFeedParams {
  readonly $type: typeof ACTIVITY_FEED_PARAMS_TYPE
  /** Which kind of activity to include; omitted means `all`. */
  readonly filter?: string
  /** Viewer whose follows scope the feed when `following` is true. */
  readonly viewerDid?: string
  /** Limit the feed to accounts the viewer follows. */
  readonly following?: boolean
}

/** Discriminator retained when the public open union receives an unknown variant. */
export interface UnknownFeedParams {
  /** Lexicon type that selects the parameter validator for this feed. */
  readonly $type: string
}

/** Parameters for any feed algorithm accepted by the public open union. */
export type FeedParams = ActivityFeedParams | UnknownFeedParams

/** Raw request body shared by both feed procedures. */
export interface FeedRequest {
  /** Identifier used to select the feed algorithm. */
  readonly feedId: string
  /** Optional algorithm-specific parameters selected by their discriminator. */
  readonly params?: FeedParams
  /** Requested page size; the selected feed owns its default and supported maximum. */
  readonly limit?: number
  /** Opaque cursor returned by an earlier page of this feed. */
  readonly cursor?: string
}

/** A reference to one project, observation, organization, or post record. */
export interface RecordItem {
  readonly $type: typeof RECORD_ITEM_TYPE
  readonly kind: RecordItemKind
  readonly uri: string
  /** Omitted when Hyperindex has not stored a CID for the record. */
  readonly cid?: string
  readonly did: string
  readonly createdAt: string
}

/** A reference to one repost record and the record it reposts. */
export interface RepostItem {
  readonly $type: typeof REPOST_ITEM_TYPE
  readonly uri: string
  /** Omitted when Hyperindex has not stored a CID for the repost. */
  readonly cid?: string
  readonly did: string
  readonly createdAt: string
  /** AT-URI of the reposted record. */
  readonly subject: string
}

/** A run of observations by one account that are adjacent in the feed. */
export interface BurstItem {
  readonly $type: typeof BURST_ITEM_TYPE
  readonly did: string
  /** Exact number of observations in the run. */
  readonly total: number
  /** createdAt of the oldest observation in the run. */
  readonly from: string
  /** createdAt of the newest observation in the run. */
  readonly to: string
  /** Up to 20 observation URIs, newest first. */
  readonly subjects: readonly string[]
}

/** The recordings one account uploaded into one folder on one UTC day. */
export interface AudioItem {
  readonly $type: typeof AUDIO_ITEM_TYPE
  readonly did: string
  /** UTC day, formatted YYYY-MM-DD. */
  readonly day: string
  /** AT-URI of the recorder folder, when the recordings belong to one. */
  readonly deployment?: string
  /** Exact number of recordings in the group. */
  readonly total: number
  /** createdAt of the newest recording in the group. */
  readonly createdAt: string
  /** Up to 20 recording URIs, newest first. */
  readonly subjects: readonly string[]
}

/** One entry of the activity feed: references and selection metadata, never records. */
export type ActivityFeedItem = RecordItem | RepostItem | BurstItem | AudioItem

/** Public response body from app.gainforest.feed.getFeed. */
export interface GetFeedOutput {
  /** Ordered feed items for the current page. */
  readonly feed: readonly ActivityFeedItem[]
  /** Opaque cursor for a possible later page; absent at the known end. */
  readonly cursor?: string
}

/** One unhydrated record selected for the feed. */
export interface FeedSkeletonItem {
  /** AT-URI of the record that the caller should hydrate. */
  readonly subject: string
}

/** Public response body from app.gainforest.feed.getFeedSkeleton. */
export interface GetFeedSkeletonOutput {
  /** Ordered, unhydrated feed records for the current page. */
  readonly feed: readonly FeedSkeletonItem[]
  /** Opaque cursor for a possible later page; absent at the known end. */
  readonly cursor?: string
}

/** Fully validated request passed to the SQL adapter. */
export interface NormalizedActivityRequest {
  /** Which kind of activity to include. */
  readonly filter: ActivityFilter
  /** Viewer whose follows scope the feed; present only when `following` is true. */
  readonly viewerDid?: string
  /** Whether the feed is limited to accounts the viewer follows. */
  readonly following: boolean
  /** Page size in the inclusive range 1..50. */
  readonly limit: number
  /** Raw cursor supplied by the caller, if any. */
  readonly cursor?: string
}
