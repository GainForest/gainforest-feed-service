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
  'audio',
] as const

/** Which kind of record a `recordItem` points at. */
export type RecordItemKind = (typeof RECORD_ITEM_KINDS)[number]

/** Wire discriminators for the feed item union. */
export const RECORD_ITEM_TYPE = 'app.gainforest.feed.defs#recordItem' as const
export const REPOST_ITEM_TYPE = 'app.gainforest.feed.defs#repostItem' as const
export const GROUP_ITEM_TYPE = 'app.gainforest.feed.defs#groupItem' as const

/** Bounded metric label for one feed item. */
export type FeedItemKind = RecordItemKind | 'repost' | 'group'

/** Parameters accepted by the activity feed. */
export interface ActivityFeedParams {
  readonly $type: typeof ACTIVITY_FEED_PARAMS_TYPE
  /** Which kind of activity to include; omitted means `all`. */
  readonly filter?: string
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

/** A reference to one project, observation, organization, post, or audio recording. */
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

/** Kinds of record that can form a group. */
export type GroupKind = 'observation' | 'audio'

/**
 * Fewest rows a group needs. A group of fewer rows is returned as separate
 * record items, each at its own position in the feed.
 */
export const MIN_GROUP_ROWS = 3

/** Most sample URIs a group item references. */
export const GROUP_SAMPLE_SIZE = 20

/**
 * Observations by one account, or recordings in one recorder folder, that the
 * page folded into one card: at least `MIN_GROUP_ROWS` rows whose neighbours
 * inside the group are no more than 12 hours apart.
 */
export interface GroupItem {
  readonly $type: typeof GROUP_ITEM_TYPE
  readonly kind: GroupKind
  /** Account of the observations, or owner of the recorder folder. */
  readonly did: string
  /**
   * AT-URI of the recorder folder, when the recordings belong to one and it is
   * a valid AT-URI. A `deploymentRef` that is not one is left out.
   */
  readonly deployment?: string
  /** Stable hash of the group's kind, owner, and folder; the same on every page. */
  readonly groupKey: string
  /** Number of rows in this card. */
  readonly total: number
  /** createdAt of the oldest row in this card. */
  readonly from: string
  /** createdAt of the newest row in this card. This orders the card in the feed. */
  readonly to: string
  /** Up to 20 URIs from this card, newest first. */
  readonly subjects: readonly string[]
  /**
   * True when the request's row budget ended the page while this card could
   * still be continued: it is the group's latest card, and the page's last row
   * is within 12 hours of its oldest row, so a later row can join it. Omitted
   * otherwise. Its absence does not mean the group is complete: a group also
   * continues after a page that ended for another reason. Clients always merge
   * cards by `groupKey` and the 12-hour rule.
   */
  readonly more?: boolean
}

/** One entry of the activity feed: references and selection metadata, never records. */
export type ActivityFeedItem = RecordItem | RepostItem | GroupItem

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
  /** Cards a page is built from, in the inclusive range 1..50. */
  readonly limit: number
  /** Raw cursor supplied by the caller, if any. */
  readonly cursor?: string
}
