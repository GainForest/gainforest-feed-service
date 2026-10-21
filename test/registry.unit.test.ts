import { describe, expect, it } from 'vitest'

import { FeedErrorCode } from '../src/feed/errors.js'
import type {
  FeedPageMode,
  FeedPagination,
  InternalFeedPage,
  InternalFeedRow,
  InternalSourceFeedRow,
  RegisteredFeed,
} from '../src/feed/registry.js'
import { FeedRegistry } from '../src/feed/registry.js'
import type { FeedParams } from '../src/feed/types.js'

const feedId = 'org.hypercerts.feed.defs#hypercertsFeed'
const paramsType = 'org.hypercerts.feed.defs#hypercertsFeedParams'
const actorDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const uri = `at://${actorDid}/org.hypercerts.claim.activity/3kpn`

const row: InternalFeedRow = {
  uri,
  cid: 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u',
  collection: 'org.hypercerts.claim.activity',
  actorDid,
  kind: 'cert.create',
  sortValue: '2026-07-21T10:00:00.000000Z',
}

class FakeRegisteredFeed implements RegisteredFeed {
  readonly loadCalls: {
    readonly params: FeedParams | undefined
    readonly pagination: FeedPagination
    readonly mode: FeedPageMode
  }[] = []

  constructor(
    readonly id: string,
    readonly paramsType: string | undefined,
  ) {}

  loadPage(
    params: FeedParams | undefined,
    pagination: FeedPagination,
    mode: 'metadata',
  ): Promise<InternalFeedPage<InternalFeedRow>>
  loadPage(
    params: FeedParams | undefined,
    pagination: FeedPagination,
    mode: 'with-source',
  ): Promise<InternalFeedPage<InternalSourceFeedRow>>
  loadPage(
    params: FeedParams | undefined,
    pagination: FeedPagination,
    mode: FeedPageMode,
  ): Promise<InternalFeedPage<InternalFeedRow | InternalSourceFeedRow>> {
    this.loadCalls.push({ params, pagination, mode })
    return Promise.resolve(
      mode === 'metadata'
        ? { rows: [row] }
        : { rows: [{ ...row, sourceValue: { title: 'Source' } }] },
    )
  }
}

describe('FeedRegistry', () => {
  it('dispatches a matching feed and params type', async () => {
    const feed = new FakeRegisteredFeed(feedId, paramsType)
    const registry = new FeedRegistry([feed])
    const params = { $type: paramsType, viewerDid: actorDid } as const

    await expect(
      registry.loadPage({ feedId, params }, 'metadata'),
    ).resolves.toEqual({ rows: [row] })
    expect(feed.loadCalls).toEqual([
      { params, pagination: {}, mode: 'metadata' },
    ])
  })

  it('dispatches a feed that accepts no algorithm-specific params', async () => {
    const feed = new FakeRegisteredFeed(feedId, undefined)
    const registry = new FeedRegistry([feed])

    await expect(
      registry.loadPage({ feedId, limit: 10, cursor: 'next-page' }, 'metadata'),
    ).resolves.toEqual({ rows: [row] })
    expect(feed.loadCalls).toEqual([
      {
        params: undefined,
        pagination: { limit: 10, cursor: 'next-page' },
        mode: 'metadata',
      },
    ])
  })

  it('rejects missing params when the selected feed requires them', async () => {
    const feed = new FakeRegisteredFeed(feedId, paramsType)
    const registry = new FeedRegistry([feed])

    const missingParamsRequest = registry.loadPage({ feedId }, 'metadata')
    await expect(missingParamsRequest).rejects.toThrow(paramsType)
    await expect(missingParamsRequest).rejects.toMatchObject({
      code: FeedErrorCode.InvalidRequest,
    })
    expect(feed.loadCalls).toEqual([])
  })

  it('dispatches source-aware mode without changing the selected params', async () => {
    const feed = new FakeRegisteredFeed(feedId, paramsType)
    const registry = new FeedRegistry([feed])
    const params = { $type: paramsType, viewerDid: actorDid } as const

    await expect(
      registry.loadPage({ feedId, params }, 'with-source'),
    ).resolves.toEqual({
      rows: [{ ...row, sourceValue: { title: 'Source' } }],
    })
    expect(feed.loadCalls).toEqual([
      { params, pagination: {}, mode: 'with-source' },
    ])
  })

  it('rejects duplicate feed identifiers at construction', () => {
    expect(
      () =>
        new FeedRegistry([
          new FakeRegisteredFeed(feedId, paramsType),
          new FakeRegisteredFeed(feedId, paramsType),
        ]),
    ).toThrow(feedId)
  })

  it('rejects an unknown feed before inspecting its params', async () => {
    const feed = new FakeRegisteredFeed(feedId, paramsType)
    const registry = new FeedRegistry([feed])

    await expect(
      registry.loadPage(
        {
          feedId: 'org.hypercerts.feed.defs#missingFeed',
          params: { $type: 'malformed' },
        },
        'metadata',
      ),
    ).rejects.toMatchObject({ code: FeedErrorCode.UnsupportedFeed })
    expect(feed.loadCalls).toEqual([])
  })

  it('rejects params that do not match the selected registration', async () => {
    const feed = new FakeRegisteredFeed(feedId, paramsType)
    const registry = new FeedRegistry([feed])

    const mismatchedParamsRequest = registry.loadPage(
      {
        feedId,
        params: { $type: 'org.hypercerts.feed.defs#otherParams' },
      },
      'metadata',
    )
    await expect(mismatchedParamsRequest).rejects.toThrow(paramsType)
    await expect(mismatchedParamsRequest).rejects.toMatchObject({
      code: FeedErrorCode.InvalidRequest,
    })
    expect(feed.loadCalls).toEqual([])
  })
})
