import type { ActivityFeedItem, FeedItemKind } from './types.js'

/** Bounded metric label for one feed item. */
export const feedItemKind = (item: ActivityFeedItem): FeedItemKind => {
  switch (item.$type) {
    case 'app.gainforest.feed.defs#recordItem':
      return item.kind
    case 'app.gainforest.feed.defs#repostItem':
      return 'repost'
    case 'app.gainforest.feed.defs#groupItem':
      return 'group'
  }
}
