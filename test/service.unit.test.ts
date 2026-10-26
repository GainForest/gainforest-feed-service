import { describe, expect, it } from 'vitest'

import type { FeedPage, FeedPageLoader } from '../src/feed/registry.js'
import { FeedService } from '../src/feed/service.js'
import {
  ACTIVITY_FEED_ID,
  ACTIVITY_FEED_PARAMS_TYPE,
  AUDIO_ITEM_TYPE,
  BURST_ITEM_TYPE,
  RECORD_ITEM_TYPE,
  REPOST_ITEM_TYPE,
  type FeedRequest,
} from '../src/feed/types.js'

const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const authorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const at = (collection: string, rkey: string): string =>
  `at://${authorDid}/${collection}/${rkey}`

const input: FeedRequest = {
  feedId: ACTIVITY_FEED_ID,
  params: { $type: ACTIVITY_FEED_PARAMS_TYPE, viewerDid },
}

const page: FeedPage = {
  items: [
    {
      $type: RECORD_ITEM_TYPE,
      kind: 'project',
      uri: at('org.hypercerts.collection', 'p1'),
      cid,
      did: authorDid,
      createdAt: '2026-07-21T10:00:05.000Z',
    },
    {
      $type: REPOST_ITEM_TYPE,
      uri: at('app.gainforest.feed.repost', 'r1'),
      cid,
      did: authorDid,
      createdAt: '2026-07-21T10:00:04.000Z',
      subject: at('app.gainforest.feed.post', 'subject'),
    },
    {
      $type: BURST_ITEM_TYPE,
      did: authorDid,
      total: 200,
      from: '2026-07-21T09:00:00.000Z',
      to: '2026-07-21T10:00:03.000Z',
      subjects: [
        at('app.gainforest.dwc.occurrence', 'o3'),
        at('app.gainforest.dwc.occurrence', 'o2'),
      ],
      groupKey: 'AAAAAAAAAAAAAAAAAAAAAA',
      continued: false,
      capped: true,
    },
    {
      $type: AUDIO_ITEM_TYPE,
      did: authorDid,
      total: 40,
      from: '2026-07-20T22:00:00.000Z',
      to: '2026-07-20T23:00:00.000Z',
      subjects: [
        at('app.gainforest.ac.audio', 'a2'),
        at('app.gainforest.ac.audio', 'a1'),
      ],
      groupKey: 'BBBBBBBBBBBBBBBBBBBBBB',
      continued: false,
      capped: false,
    },
  ],
  cursor: 'opaque-cursor',
}

class FakePageLoader implements FeedPageLoader {
  readonly calls: FeedRequest[] = []

  constructor(private readonly selected: FeedPage) {}

  loadPage(request: FeedRequest): Promise<FeedPage> {
    this.calls.push(request)
    return Promise.resolve(this.selected)
  }
}

describe('FeedService', () => {
  it('returns the selected items and cursor from getFeed unchanged', async () => {
    const pages = new FakePageLoader(page)

    await expect(new FeedService(pages).getFeed(input)).resolves.toEqual({
      feed: page.items,
      cursor: 'opaque-cursor',
    })
    expect(pages.calls).toEqual([input])
  })

  it('flattens the same page into skeleton subjects in feed order', async () => {
    const pages = new FakePageLoader(page)

    await expect(
      new FeedService(pages).getFeedSkeleton(input),
    ).resolves.toEqual({
      feed: [
        { subject: at('org.hypercerts.collection', 'p1') },
        { subject: at('app.gainforest.feed.repost', 'r1') },
        { subject: at('app.gainforest.dwc.occurrence', 'o3') },
        { subject: at('app.gainforest.dwc.occurrence', 'o2') },
        { subject: at('app.gainforest.ac.audio', 'a2') },
        { subject: at('app.gainforest.ac.audio', 'a1') },
      ],
      cursor: 'opaque-cursor',
    })
  })

  it('omits the cursor when the selected page has none', async () => {
    const lastPage: FeedPage = { items: page.items.slice(0, 1) }
    const service = new FeedService(new FakePageLoader(lastPage))

    const feed = await service.getFeed(input)
    const skeleton = await service.getFeedSkeleton(input)
    expect(Object.hasOwn(feed, 'cursor')).toBe(false)
    expect(Object.hasOwn(skeleton, 'cursor')).toBe(false)
  })
})
