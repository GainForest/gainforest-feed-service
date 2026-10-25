import { describe, expect, it } from 'vitest'

import { FeedErrorCode } from '../src/feed/errors.js'
import type {
  FeedPage,
  FeedPagination,
  RegisteredFeed,
} from '../src/feed/registry.js'
import { FeedRegistry } from '../src/feed/registry.js'
import {
  ACTIVITY_FEED_ID,
  ACTIVITY_FEED_PARAMS_TYPE,
  RECORD_ITEM_TYPE,
  type FeedParams,
} from '../src/feed/types.js'

const did = 'did:plc:ar7c4by46qjdydhdevvrndac'
const page: FeedPage = {
  items: [
    {
      $type: RECORD_ITEM_TYPE,
      kind: 'post',
      uri: `at://${did}/app.gainforest.feed.post/3kpn`,
      cid: 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u',
      did,
      createdAt: '2026-07-21T10:00:00.000Z',
    },
  ],
}

class FakeRegisteredFeed implements RegisteredFeed {
  readonly loadCalls: {
    readonly params: FeedParams | undefined
    readonly pagination: FeedPagination
  }[] = []

  constructor(
    readonly id: string,
    readonly paramsType: string | undefined,
    readonly defaultParams?: FeedParams,
  ) {}

  loadPage(
    params: FeedParams | undefined,
    pagination: FeedPagination,
  ): Promise<FeedPage> {
    this.loadCalls.push({ params, pagination })
    return Promise.resolve(page)
  }
}

describe('FeedRegistry', () => {
  it('dispatches a matching feed and params type', async () => {
    const feed = new FakeRegisteredFeed(
      ACTIVITY_FEED_ID,
      ACTIVITY_FEED_PARAMS_TYPE,
    )
    const registry = new FeedRegistry([feed])
    const params = { $type: ACTIVITY_FEED_PARAMS_TYPE, filter: 'post' } as const

    await expect(
      registry.loadPage({ feedId: ACTIVITY_FEED_ID, params }),
    ).resolves.toEqual(page)
    expect(feed.loadCalls).toEqual([{ params, pagination: {} }])
  })

  it('dispatches a feed that accepts no algorithm-specific params', async () => {
    const feed = new FakeRegisteredFeed(ACTIVITY_FEED_ID, undefined)
    const registry = new FeedRegistry([feed])

    await expect(
      registry.loadPage({
        feedId: ACTIVITY_FEED_ID,
        limit: 10,
        cursor: 'next-page',
      }),
    ).resolves.toEqual(page)
    expect(feed.loadCalls).toEqual([
      {
        params: undefined,
        pagination: { limit: 10, cursor: 'next-page' },
      },
    ])
  })

  it("applies the selected feed's default params when a request omits them", async () => {
    const defaults = { $type: ACTIVITY_FEED_PARAMS_TYPE } as const
    const feed = new FakeRegisteredFeed(
      ACTIVITY_FEED_ID,
      ACTIVITY_FEED_PARAMS_TYPE,
      defaults,
    )
    const registry = new FeedRegistry([feed])

    await expect(
      registry.loadPage({ feedId: ACTIVITY_FEED_ID, limit: 5 }),
    ).resolves.toEqual(page)
    expect(feed.loadCalls).toEqual([
      { params: defaults, pagination: { limit: 5 } },
    ])
  })

  it('prefers supplied params over the defaults', async () => {
    const feed = new FakeRegisteredFeed(
      ACTIVITY_FEED_ID,
      ACTIVITY_FEED_PARAMS_TYPE,
      { $type: ACTIVITY_FEED_PARAMS_TYPE },
    )
    const registry = new FeedRegistry([feed])
    const params = { $type: ACTIVITY_FEED_PARAMS_TYPE, filter: 'post' } as const

    await registry.loadPage({ feedId: ACTIVITY_FEED_ID, params })

    expect(feed.loadCalls).toEqual([{ params, pagination: {} }])
  })

  it('rejects params for a feed that accepts none', async () => {
    const feed = new FakeRegisteredFeed(ACTIVITY_FEED_ID, undefined)
    const registry = new FeedRegistry([feed])

    await expect(
      registry.loadPage({
        feedId: ACTIVITY_FEED_ID,
        params: { $type: ACTIVITY_FEED_PARAMS_TYPE },
      }),
    ).rejects.toMatchObject({ code: FeedErrorCode.InvalidRequest })
    expect(feed.loadCalls).toEqual([])
  })

  it('rejects missing params when the selected feed requires them', async () => {
    const feed = new FakeRegisteredFeed(
      ACTIVITY_FEED_ID,
      ACTIVITY_FEED_PARAMS_TYPE,
    )
    const registry = new FeedRegistry([feed])

    const missingParamsRequest = registry.loadPage({
      feedId: ACTIVITY_FEED_ID,
    })
    await expect(missingParamsRequest).rejects.toThrow(
      ACTIVITY_FEED_PARAMS_TYPE,
    )
    await expect(missingParamsRequest).rejects.toMatchObject({
      code: FeedErrorCode.InvalidRequest,
    })
    expect(feed.loadCalls).toEqual([])
  })

  it('rejects duplicate feed identifiers at construction', () => {
    expect(
      () =>
        new FeedRegistry([
          new FakeRegisteredFeed(ACTIVITY_FEED_ID, ACTIVITY_FEED_PARAMS_TYPE),
          new FakeRegisteredFeed(ACTIVITY_FEED_ID, ACTIVITY_FEED_PARAMS_TYPE),
        ]),
    ).toThrow(ACTIVITY_FEED_ID)
  })

  it('rejects an unknown feed before inspecting its params', async () => {
    const feed = new FakeRegisteredFeed(
      ACTIVITY_FEED_ID,
      ACTIVITY_FEED_PARAMS_TYPE,
    )
    const registry = new FeedRegistry([feed])

    await expect(
      registry.loadPage({
        feedId: 'app.gainforest.feed.defs#missingFeed',
        params: { $type: 'malformed' },
      }),
    ).rejects.toMatchObject({ code: FeedErrorCode.UnsupportedFeed })
    expect(feed.loadCalls).toEqual([])
  })

  it('rejects params that do not match the selected registration', async () => {
    const feed = new FakeRegisteredFeed(
      ACTIVITY_FEED_ID,
      ACTIVITY_FEED_PARAMS_TYPE,
    )
    const registry = new FeedRegistry([feed])

    const mismatchedParamsRequest = registry.loadPage({
      feedId: ACTIVITY_FEED_ID,
      params: { $type: 'app.gainforest.feed.defs#otherParams' },
    })
    await expect(mismatchedParamsRequest).rejects.toThrow(
      ACTIVITY_FEED_PARAMS_TYPE,
    )
    await expect(mismatchedParamsRequest).rejects.toMatchObject({
      code: FeedErrorCode.InvalidRequest,
    })
    expect(feed.loadCalls).toEqual([])
  })
})
