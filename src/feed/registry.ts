import { FeedError, FeedErrorCode } from './errors.js'
import type { ActivityFeedItem, FeedParams, FeedRequest } from './types.js'

/** Pagination controls shared by every registered feed. */
export interface FeedPagination {
  readonly limit?: number
  readonly cursor?: string
}

/** One selected page of feed items and the cursor for the next page, if any. */
export interface FeedPage {
  readonly items: readonly ActivityFeedItem[]
  /**
   * The AT-URI of every record the items cover, in item order: a record or
   * repost item contributes its own URI, a group item every member, newest
   * first. A group's later members therefore come before the rows that lie
   * between them in the feed. This is the page `getFeedSkeleton` returns.
   */
  readonly uris: readonly string[]
  readonly cursor?: string
}

/** Loads one feed page for a request, dispatching on its feed identifier. */
export interface FeedPageLoader {
  loadPage(input: FeedRequest): Promise<FeedPage>
}

export interface RegisteredFeed {
  readonly id: string
  /** Params discriminator, or undefined when the feed accepts no params. */
  readonly paramsType: string | undefined
  /** Params applied when a request omits them; undefined makes params required. */
  readonly defaultParams?: FeedParams | undefined

  loadPage(
    params: FeedParams | undefined,
    pagination: FeedPagination,
  ): Promise<FeedPage>
}

export class FeedRegistry implements FeedPageLoader {
  readonly #feeds = new Map<string, RegisteredFeed>()

  constructor(feeds: readonly RegisteredFeed[]) {
    for (const feed of feeds) {
      if (this.#feeds.has(feed.id)) {
        throw new Error(
          `Feed registry contains duplicate feedId ${JSON.stringify(feed.id)}; register each feed identifier exactly once.`,
        )
      }
      this.#feeds.set(feed.id, feed)
    }
  }

  async loadPage(input: FeedRequest): Promise<FeedPage> {
    const feed = this.#feeds.get(input.feedId)
    if (feed === undefined) {
      throw new FeedError(
        FeedErrorCode.UnsupportedFeed,
        `feedId ${JSON.stringify(input.feedId)} is not registered by this service; use a supported feed identifier and retry.`,
      )
    }
    const params = input.params ?? feed.defaultParams
    if (feed.paramsType === undefined) {
      if (params !== undefined) {
        throw new FeedError(
          FeedErrorCode.InvalidRequest,
          `feedId ${JSON.stringify(input.feedId)} does not accept algorithm-specific params; omit params and retry.`,
        )
      }
    } else if (params === undefined) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        `feedId ${JSON.stringify(input.feedId)} requires params with $type ${JSON.stringify(feed.paramsType)}; provide those params and retry.`,
      )
    } else if (params.$type !== feed.paramsType) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        `params.$type ${JSON.stringify(params.$type)} does not match feedId ${JSON.stringify(input.feedId)}; use ${JSON.stringify(feed.paramsType)} and retry.`,
      )
    }

    const pagination: FeedPagination = {
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }
    return feed.loadPage(params, pagination)
  }
}
