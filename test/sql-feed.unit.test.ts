import type { QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import {
  decodeCursor,
  encodeCursor,
  timestampUriCursor,
  type FeedCursor,
} from '../src/feed/cursor.js'
import { FeedErrorCode } from '../src/feed/errors.js'
import {
  defineSqlFeed,
  type SelectedItem,
  type SelectedPage,
  type SqlFeedQueryExecutor,
} from '../src/feed/sql-feed.js'
import {
  BURST_ITEM_TYPE,
  RECORD_ITEM_TYPE,
  type FeedParams,
} from '../src/feed/types.js'
import { Metrics } from '../src/metrics.js'

const feedId = 'app.gainforest.feed.defs#testFeed'
const paramsType = 'app.gainforest.feed.defs#testFeedParams'
const otherFeedId = 'app.gainforest.feed.defs#otherFeed'
const did = 'did:plc:ar7c4by46qjdydhdevvrndac'
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'

const emptyDatabase: SqlFeedQueryExecutor<QueryResultRow> = {
  query: () => Promise.resolve({ rows: [] }),
}

const recordItem = (suffix: string, second: number): SelectedItem => {
  const uri = `at://${did}/app.gainforest.feed.post/${suffix}`
  const sortValue = `2026-07-21T10:00:0${String(second)}.000000Z`
  return {
    item: {
      $type: RECORD_ITEM_TYPE,
      kind: 'post',
      uri,
      cid,
      did,
      createdAt: sortValue,
    },
    position: { sortValue, uri },
  }
}

interface SelectCall {
  readonly limit: number
  readonly cursor: FeedCursor | undefined
}

const createFeed = (
  selected: SelectedPage,
  calls: SelectCall[] = [],
  metrics = new Metrics(),
  defaults?: { readonly $type: string },
) =>
  defineSqlFeed(
    { database: emptyDatabase, metrics },
    {
      id: feedId,
      params: {
        type: paramsType,
        ...(defaults === undefined ? {} : { default: defaults }),
        parse: (input: FeedParams) => ({ $type: input.$type }),
        normalize: (_params, pagination) => ({
          limit: pagination.limit ?? 2,
          ...(pagination.cursor === undefined
            ? {}
            : { cursor: pagination.cursor }),
        }),
      },
      cursor: timestampUriCursor,
      select: (_database, input) => {
        calls.push({ limit: input.params.limit, cursor: input.cursor })
        return Promise.resolve(selected)
      },
    },
  )

describe('defineSqlFeed', () => {
  it('encodes the next cursor from the last selected item only when another page follows', async () => {
    const first = recordItem('3', 3)
    const last = recordItem('2', 2)
    const feed = createFeed({ items: [first, last], hasNext: true })

    const page = await feed.loadPage({ $type: paramsType }, { limit: 2 })

    expect(page.items).toEqual([first.item, last.item])
    expect(decodeCursor(feedId, page.cursor, timestampUriCursor)).toEqual({
      value: last.position.sortValue,
      uri: last.position.uri,
    })

    const end = await createFeed({ items: [first], hasNext: false }).loadPage(
      { $type: paramsType },
      {},
    )
    expect(Object.hasOwn(end, 'cursor')).toBe(false)
  })

  it('points the cursor at the last row a burst consumed, not at its newest row', async () => {
    const oldestMember = `at://${did}/app.gainforest.dwc.occurrence/oldest`
    const burst: SelectedItem = {
      item: {
        $type: BURST_ITEM_TYPE,
        did,
        total: 3,
        from: '2026-07-21T10:00:01.000Z',
        to: '2026-07-21T10:00:03.000Z',
        subjects: [`at://${did}/app.gainforest.dwc.occurrence/newest`],
      },
      position: {
        sortValue: '2026-07-21T10:00:01.000000Z',
        uri: oldestMember,
      },
    }
    const page = await createFeed({ items: [burst], hasNext: true }).loadPage(
      { $type: paramsType },
      {},
    )

    expect(decodeCursor(feedId, page.cursor, timestampUriCursor)).toEqual({
      value: '2026-07-21T10:00:01.000000Z',
      uri: oldestMember,
    })
  })

  it('hands the decoded cursor and normalized limit to the selection', async () => {
    const calls: SelectCall[] = []
    const position = recordItem('1', 1).position
    const cursor = encodeCursor(feedId, position, timestampUriCursor)

    await createFeed({ items: [], hasNext: false }, calls).loadPage(
      { $type: paramsType },
      { limit: 7, cursor },
    )

    expect(calls).toEqual([
      { limit: 7, cursor: { value: position.sortValue, uri: position.uri } },
    ])
  })

  it('rejects a selection larger than the page limit', async () => {
    const feed = createFeed({
      items: [recordItem('3', 3), recordItem('2', 2), recordItem('1', 1)],
      hasNext: false,
    })

    await expect(
      feed.loadPage({ $type: paramsType }, { limit: 2 }),
    ).rejects.toThrow(/selected 3 items for a page limit of 2/i)
  })

  it('requires params with the registered discriminator', async () => {
    const feed = createFeed({ items: [], hasNext: false })

    await expect(feed.loadPage(undefined, {})).rejects.toMatchObject({
      code: FeedErrorCode.InvalidRequest,
    })
    await expect(
      feed.loadPage({ $type: 'app.gainforest.feed.defs#other' }, {}),
    ).rejects.toMatchObject({ code: FeedErrorCode.InvalidRequest })
  })

  it('applies the default params when a request omits them', async () => {
    const calls: SelectCall[] = []
    const feed = createFeed(
      { items: [], hasNext: false },
      calls,
      new Metrics(),
      { $type: paramsType },
    )

    expect(feed.defaultParams).toEqual({ $type: paramsType })
    await expect(feed.loadPage(undefined, { limit: 4 })).resolves.toEqual({
      items: [],
    })
    expect(calls).toEqual([{ limit: 4, cursor: undefined }])
  })

  it('rejects another feed cursor before selecting', async () => {
    const calls: SelectCall[] = []
    const cursor = encodeCursor(
      otherFeedId,
      recordItem('1', 1).position,
      timestampUriCursor,
    )

    await expect(
      createFeed({ items: [], hasNext: false }, calls).loadPage(
        { $type: paramsType },
        { cursor },
      ),
    ).rejects.toMatchObject({ code: FeedErrorCode.InvalidCursor })
    expect(calls).toEqual([])
  })

  it('records result kinds and database timing', async () => {
    const metrics = new Metrics()
    await createFeed(
      { items: [recordItem('1', 1)], hasNext: false },
      [],
      metrics,
    ).loadPage({ $type: paramsType }, {})

    const exposition = await metrics.registry.metrics()
    expect(exposition).toContain(
      'hypercerts_feed_database_duration_seconds_count{operation="feed"} 1',
    )
    expect(exposition).toContain(
      'hypercerts_feed_result_kinds_total{kind="post"} 1',
    )
  })

  it('records database timing when the selection rejects', async () => {
    const metrics = new Metrics()
    const failure = new Error('database unavailable')
    const feed = defineSqlFeed(
      { database: emptyDatabase, metrics },
      {
        id: feedId,
        params: {
          type: paramsType,
          parse: (input: FeedParams) => ({ $type: input.$type }),
          normalize: () => ({ limit: 2 }),
        },
        cursor: timestampUriCursor,
        select: () => Promise.reject(failure),
      },
    )

    await expect(feed.loadPage({ $type: paramsType }, {})).rejects.toBe(failure)
    expect(await metrics.registry.metrics()).toContain(
      'hypercerts_feed_database_duration_seconds_count{operation="feed"} 1',
    )
  })
})
