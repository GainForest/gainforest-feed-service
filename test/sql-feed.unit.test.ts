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
  type FeedPosition,
  type SelectedItem,
  type SelectedPage,
  type SqlFeedQueryExecutor,
} from '../src/feed/sql-feed.js'
import {
  GROUP_ITEM_TYPE,
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

const positionOf = (suffix: string, second: number): FeedPosition => ({
  sortValue: `2026-07-21T10:00:0${String(second)}.000000Z`,
  uri: `at://${did}/app.gainforest.feed.post/${suffix}`,
})

const recordItem = (suffix: string, second: number): SelectedItem => {
  const { uri, sortValue } = positionOf(suffix, second)
  return {
    item: {
      $type: RECORD_ITEM_TYPE,
      kind: 'post',
      uri,
      cid,
      did,
      createdAt: sortValue,
    },
    uris: [uri],
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
      metricName: 'activity',
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
  it('encodes the cursor from the position the selection returns, and only then', async () => {
    const first = recordItem('3', 3)
    const last = recordItem('2', 2)
    const next = positionOf('2', 2)
    const feed = createFeed({ items: [first, last], next })

    const page = await feed.loadPage({ $type: paramsType }, { limit: 2 })

    expect(page.items).toEqual([first.item, last.item])
    expect(decodeCursor(feedId, page.cursor, timestampUriCursor)).toEqual({
      value: next.sortValue,
      uri: next.uri,
    })

    const end = await createFeed({ items: [first] }).loadPage(
      { $type: paramsType },
      {},
    )
    expect(Object.hasOwn(end, 'cursor')).toBe(false)
  })

  it('points the cursor at the row the selection consumed last, not at the last item', async () => {
    // A card that sits early on the page can hold the last row the page took.
    const lastConsumed = `at://${did}/app.gainforest.dwc.occurrence/oldest`
    const group: SelectedItem = {
      item: {
        $type: GROUP_ITEM_TYPE,
        kind: 'observation',
        did,
        total: 3,
        from: '2026-07-21T10:00:01.000Z',
        to: '2026-07-21T10:00:03.000Z',
        subjects: [`at://${did}/app.gainforest.dwc.occurrence/newest`],
        groupKey: 'AAAAAAAAAAAAAAAAAAAAAA',
      },
      uris: [`at://${did}/app.gainforest.dwc.occurrence/newest`, lastConsumed],
    }
    const page = await createFeed({
      items: [group, recordItem('1', 1)],
      next: { sortValue: '2026-07-21T10:00:00.500000Z', uri: lastConsumed },
    }).loadPage({ $type: paramsType }, {})

    expect(decodeCursor(feedId, page.cursor, timestampUriCursor)).toEqual({
      value: '2026-07-21T10:00:00.500000Z',
      uri: lastConsumed,
    })
  })

  it('returns every URI the items cover, in item order, for the skeleton', async () => {
    const group: SelectedItem = {
      item: {
        $type: GROUP_ITEM_TYPE,
        kind: 'audio',
        did,
        total: 3,
        from: '2026-07-21T10:00:01.000Z',
        to: '2026-07-21T10:00:03.000Z',
        subjects: ['at://x/y/1'],
        groupKey: 'AAAAAAAAAAAAAAAAAAAAAA',
      },
      uris: ['at://x/y/1', 'at://x/y/2', 'at://x/y/3'],
    }
    const page = await createFeed({
      items: [recordItem('4', 4), group, recordItem('0', 0)],
    }).loadPage({ $type: paramsType }, {})

    expect(page.uris).toEqual([
      recordItem('4', 4).uris[0],
      'at://x/y/1',
      'at://x/y/2',
      'at://x/y/3',
      recordItem('0', 0).uris[0],
    ])
  })

  it('hands the decoded cursor and normalized limit to the selection', async () => {
    const calls: SelectCall[] = []
    const position = positionOf('1', 1)
    const cursor = encodeCursor(feedId, position, timestampUriCursor)

    await createFeed({ items: [] }, calls).loadPage(
      { $type: paramsType },
      { limit: 7, cursor },
    )

    expect(calls).toEqual([
      { limit: 7, cursor: { value: position.sortValue, uri: position.uri } },
    ])
  })

  // A feed decides how many items a page holds: the activity feed counts
  // cards, and a small group becomes several records, so a page can hold more
  // items than its limit.
  it('does not cap the items a feed selects at the limit', async () => {
    const feed = createFeed({
      items: [recordItem('3', 3), recordItem('2', 2), recordItem('1', 1)],
    })

    const page = await feed.loadPage({ $type: paramsType }, { limit: 2 })

    expect(page.items).toHaveLength(3)
  })

  it('requires params with the registered discriminator', async () => {
    const feed = createFeed({ items: [] })

    await expect(feed.loadPage(undefined, {})).rejects.toMatchObject({
      code: FeedErrorCode.InvalidRequest,
    })
    await expect(
      feed.loadPage({ $type: 'app.gainforest.feed.defs#other' }, {}),
    ).rejects.toMatchObject({ code: FeedErrorCode.InvalidRequest })
  })

  it('applies the default params when a request omits them', async () => {
    const calls: SelectCall[] = []
    const feed = createFeed({ items: [] }, calls, new Metrics(), {
      $type: paramsType,
    })

    expect(feed.defaultParams).toEqual({ $type: paramsType })
    await expect(feed.loadPage(undefined, { limit: 4 })).resolves.toEqual({
      items: [],
      uris: [],
    })
    expect(calls).toEqual([{ limit: 4, cursor: undefined }])
  })

  it('rejects another feed cursor before selecting', async () => {
    const calls: SelectCall[] = []
    const cursor = encodeCursor(
      otherFeedId,
      positionOf('1', 1),
      timestampUriCursor,
    )

    await expect(
      createFeed({ items: [] }, calls).loadPage(
        { $type: paramsType },
        { cursor },
      ),
    ).rejects.toMatchObject({ code: FeedErrorCode.InvalidCursor })
    expect(calls).toEqual([])
  })

  it('records result kinds and database timing', async () => {
    const metrics = new Metrics()
    await createFeed(
      {
        items: [
          recordItem('1', 1),
          {
            item: {
              $type: GROUP_ITEM_TYPE,
              kind: 'audio',
              did,
              total: 3,
              from: '2026-07-21T10:00:01.000Z',
              to: '2026-07-21T10:00:03.000Z',
              subjects: ['at://x/y/1'],
              groupKey: 'AAAAAAAAAAAAAAAAAAAAAA',
            },
            uris: ['at://x/y/1'],
          },
        ],
      },
      [],
      metrics,
    ).loadPage({ $type: paramsType }, {})

    const exposition = await metrics.registry.metrics()
    expect(exposition).toContain(
      'hypercerts_feed_database_duration_seconds_count{operation="feed",feed="activity"} 1',
    )
    expect(exposition).toContain(
      'hypercerts_feed_result_kinds_total{kind="post"} 1',
    )
    expect(exposition).toContain(
      'hypercerts_feed_result_kinds_total{kind="group"} 1',
    )
  })

  it('records database timing when the selection rejects', async () => {
    const metrics = new Metrics()
    const failure = new Error('database unavailable')
    const feed = defineSqlFeed(
      { database: emptyDatabase, metrics },
      {
        id: feedId,
        metricName: 'following',
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
      'hypercerts_feed_database_duration_seconds_count{operation="feed",feed="following"} 1',
    )
  })
})
