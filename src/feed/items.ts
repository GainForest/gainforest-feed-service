import type { ActivityFeedItem, FeedItemKind } from './types.js'

/** Bounded metric label for one feed item. */
export const feedItemKind = (item: ActivityFeedItem): FeedItemKind => {
  switch (item.$type) {
    case 'app.gainforest.feed.defs#recordItem':
      return item.kind
    case 'app.gainforest.feed.defs#repostItem':
      return 'repost'
    case 'app.gainforest.feed.defs#burstItem':
      return 'burst'
    case 'app.gainforest.feed.defs#audioItem':
      return 'audio'
  }
}

/**
 * The AT-URIs one feed item contributes to a skeleton, in feed order. Grouped
 * items contribute their sample URIs and a repost contributes the repost
 * record's own URI.
 */
export const skeletonSubjects = (item: ActivityFeedItem): readonly string[] =>
  'subjects' in item ? item.subjects : [item.uri]
