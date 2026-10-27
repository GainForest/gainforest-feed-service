import type { FeedPageLoader } from './registry.js'
import type {
  FeedRequest,
  GetFeedOutput,
  GetFeedSkeletonOutput,
} from './types.js'

/** Application boundary consumed by the getFeed XRPC transport. */
export interface FeedReader {
  getFeed(input: FeedRequest): Promise<GetFeedOutput>
}

/** Application boundary consumed by the getFeedSkeleton XRPC transport. */
export interface FeedSkeletonReader {
  getFeedSkeleton(input: FeedRequest): Promise<GetFeedSkeletonOutput>
}

/** Projects registry-selected pages into the two public responses. */
export class FeedService implements FeedReader, FeedSkeletonReader {
  constructor(private readonly pages: FeedPageLoader) {}

  async getFeed(input: FeedRequest): Promise<GetFeedOutput> {
    const page = await this.pages.loadPage(input)
    return {
      feed: page.items,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    }
  }

  async getFeedSkeleton(input: FeedRequest): Promise<GetFeedSkeletonOutput> {
    const page = await this.pages.loadPage(input)
    return {
      feed: page.uris.map((subject) => ({ subject })),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    }
  }
}
