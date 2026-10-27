import { describe, expect, it } from 'vitest'

import { decodeCursor, timestampUriCursor } from '../src/feed/cursor.js'
import { FeedErrorCode } from '../src/feed/errors.js'
import {
  MAX_FOLLOWED_ACCOUNTS,
  createFollowingFeed,
} from '../src/feed/following.js'
import {
  BATCH_ROWS,
  createActivityFeed,
  type ActivityFeedQueryRow,
} from '../src/feed/query.js'
import { FeedRegistry } from '../src/feed/registry.js'
import type { SqlFeedQueryExecutor } from '../src/feed/sql-feed.js'
import {
  ACTIVITY_FEED_ID,
  ACTIVITY_FEED_PARAMS_TYPE,
  FOLLOWING_FEED_ID,
  FOLLOWING_FEED_PARAMS_TYPE,
  GROUP_ITEM_TYPE,
  RECORD_ITEM_TYPE,
  REPOST_ITEM_TYPE,
} from '../src/feed/types.js'
import { Metrics } from '../src/metrics.js'

const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'
const followed = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const at = (collection: string, rkey: string): string =>
  `at://${followed}/${collection}/${rkey}`
const ALL_KINDS = [
  'project',
  'observation',
  'organization',
  'post',
  'repost',
  'audio',
]

class FakeQueryExecutor implements SqlFeedQueryExecutor<ActivityFeedQueryRow> {
  readonly calls: {
    readonly text: string
    readonly values: readonly unknown[]
  }[] = []

  constructor(private readonly responses: readonly ActivityFeedQueryRow[][]) {}

  query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly ActivityFeedQueryRow[] }> {
    this.calls.push({ text, values })
    const rows = this.responses[this.calls.length - 1]
    if (rows === undefined) {
      return Promise.reject(new Error('unexpected extra feed query'))
    }
    return Promise.resolve({ rows })
  }
}

/** The time of the row `index` seconds after 2026-07-21T10:00:00Z, as the statement formats it. */
const timeOf = (index: number): string =>
  new Date(Date.parse('2026-07-21T10:00:00Z') + index * 1_000)
    .toISOString()
    .replace('Z', '000Z')

const postRow = (
  index: number,
  overrides: Partial<ActivityFeedQueryRow> = {},
): ActivityFeedQueryRow => ({
  kind: 'post',
  uri: at('app.gainforest.feed.post', `p${String(index)}`),
  cid,
  did: followed,
  sort_value: timeOf(index),
  owner: null,
  folder: null,
  bioacoustic: false,
  subject: null,
  ...overrides,
})

const defined = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Expected a value.')
  return value
}

const createFeed = (
  database: FakeQueryExecutor,
  options?: Parameters<typeof createFollowingFeed>[1],
) => createFollowingFeed({ database, metrics: new Metrics() }, options)

const params = (overrides: Record<string, unknown> = {}) => ({
  $type: FOLLOWING_FEED_PARAMS_TYPE,
  viewerDid: viewer,
  ...overrides,
})

describe('following feed SQL definition', () => {
  it('registers under its own feed id and params type, and has no default params', () => {
    const feed = createFeed(new FakeQueryExecutor([]))

    expect(feed.id).toBe(FOLLOWING_FEED_ID)
    expect(feed.id).not.toBe(ACTIVITY_FEED_ID)
    expect(feed.paramsType).toBe(FOLLOWING_FEED_PARAMS_TYPE)
    // The feed needs a viewer, which only a request can name.
    expect(feed.defaultParams).toBeUndefined()
  })

  // The following feed costs more and depends on the viewer, so its requests
  // are a series of their own next to the activity feed's.
  it('records its database timing under its own feed label', async () => {
    const metrics = new Metrics()

    await createFollowingFeed(
      { database: new FakeQueryExecutor([[]]), metrics },
      {},
    ).loadPage(params(), {})
    await createActivityFeed({
      database: new FakeQueryExecutor([[]]),
      metrics,
    }).loadPage(undefined, {})

    const exposition = await metrics.registry.metrics()
    expect(exposition).toContain(
      'hypercerts_feed_database_duration_seconds_count{operation="feed",feed="following"} 1',
    )
    expect(exposition).toContain(
      'hypercerts_feed_database_duration_seconds_count{operation="feed",feed="activity"} 1',
    )
  })

  it('binds the statement contract: kinds, cursor, batch, viewer, and follow cap', async () => {
    const database = new FakeQueryExecutor([[]])

    await expect(
      createFeed(database).loadPage(params(), { limit: 2 }),
    ).resolves.toEqual({ items: [], uris: [] })

    expect(database.calls).toHaveLength(1)
    expect(database.calls[0]?.values).toEqual([
      ALL_KINDS,
      null,
      null,
      BATCH_ROWS,
      viewer,
      MAX_FOLLOWED_ACCOUNTS,
    ])
  })

  it('sends the following statement, not the activity statement', async () => {
    const following = new FakeQueryExecutor([[]])
    const activity = new FakeQueryExecutor([[]])

    await createFeed(following).loadPage(params(), {})
    await createActivityFeed({
      database: activity,
      metrics: new Metrics(),
    }).loadPage(undefined, {})

    expect(following.calls[0]?.text).toContain('app.certified.graph.follow')
    expect(activity.calls[0]?.text).not.toContain('app.certified.graph.follow')
    expect(following.calls[0]?.text).not.toBe(activity.calls[0]?.text)
  })

  it('binds a single kind and the cursor position', async () => {
    const database = new FakeQueryExecutor([[]])
    const position = {
      value: '2026-07-21T10:00:00.000000Z',
      uri: at('app.gainforest.ac.audio', 'o1'),
    }
    const cursor = Buffer.from(
      JSON.stringify({
        version: 3,
        feedId: FOLLOWING_FEED_ID,
        value: position,
      }),
    ).toString('base64url')

    await createFeed(database).loadPage(params({ filter: 'audio' }), {
      limit: 10,
      cursor,
    })

    expect(database.calls[0]?.values).toEqual([
      ['audio'],
      position.value,
      position.uri,
      BATCH_ROWS,
      viewer,
      MAX_FOLLOWED_ACCOUNTS,
    ])
  })

  it('reads the followed accounts up to the configured cap', async () => {
    const database = new FakeQueryExecutor([[]])

    await createFeed(database, { maxFollowedAccounts: 7 }).loadPage(
      params(),
      {},
    )

    expect(database.calls[0]?.values[5]).toBe(7)
  })

  it('caps a request at a few hundred followed accounts', () => {
    // The work of a statement grows with the followed accounts, and an
    // anonymous caller may name any account as the viewer.
    expect(MAX_FOLLOWED_ACCOUNTS).toBe(500)
  })

  it.each([
    ['batchRows', { batchRows: 0 }],
    ['requestRows', { requestRows: 1.5 }],
    ['maxFollowedAccounts', { maxFollowedAccounts: 0 }],
  ])('rejects an invalid %s option', (name, options) => {
    expect(() => createFeed(new FakeQueryExecutor([]), options)).toThrow(
      `${name} must be an integer of at least 1.`,
    )
  })

  describe('params', () => {
    it('requires params: a request without them is not a global feed', async () => {
      const database = new FakeQueryExecutor([])

      await expect(
        createFeed(database).loadPage(undefined, {}),
      ).rejects.toMatchObject({ code: FeedErrorCode.InvalidRequest })
      expect(database.calls).toEqual([])
    })

    it('registered through the registry, reports the missing params and a wrong params type', async () => {
      const registry = new FeedRegistry([createFeed(new FakeQueryExecutor([]))])

      await expect(
        registry.loadPage({ feedId: FOLLOWING_FEED_ID }),
      ).rejects.toThrow(
        `requires params with $type "${FOLLOWING_FEED_PARAMS_TYPE}"`,
      )
      await expect(
        registry.loadPage({
          feedId: FOLLOWING_FEED_ID,
          params: { $type: ACTIVITY_FEED_PARAMS_TYPE },
        }),
      ).rejects.toThrow(
        `params.$type "${ACTIVITY_FEED_PARAMS_TYPE}" does not match feedId "${FOLLOWING_FEED_ID}"`,
      )
      await expect(
        registry.loadPage({ feedId: ACTIVITY_FEED_ID }),
      ).rejects.toMatchObject({ code: FeedErrorCode.UnsupportedFeed })
    })

    it('asks for a viewer, and rejects one that is not a DID, before querying', async () => {
      const database = new FakeQueryExecutor([])
      const feed = createFeed(database)

      await expect(
        feed.loadPage({ $type: FOLLOWING_FEED_PARAMS_TYPE }, {}),
      ).rejects.toMatchObject({ code: FeedErrorCode.InvalidRequest })
      await expect(
        feed.loadPage(params({ viewerDid: 'alice.test' }), {}),
      ).rejects.toMatchObject({ code: FeedErrorCode.InvalidRequest })
      await expect(
        feed.loadPage(params({ filter: 'donation' }), {}),
      ).rejects.toMatchObject({ code: FeedErrorCode.InvalidRequest })
      await expect(
        feed.loadPage(params({ filter: 7 }), {}),
      ).rejects.toMatchObject({ code: FeedErrorCode.InvalidRequest })
      expect(database.calls).toEqual([])
    })

    // The Lexicon object is open and the feed reads only `filter` and
    // `viewerDid`, so any other property a caller sends is dropped.
    it.each([
      ['following', { following: false }],
      ['an unknown property', { somethingElse: ['x'] }],
    ])('ignores %s and answers as without it', async (_name, extra) => {
      const withExtra = new FakeQueryExecutor([[postRow(1)]])
      const without = new FakeQueryExecutor([[postRow(1)]])

      const page = await createFeed(withExtra).loadPage(
        params({ filter: 'post', ...extra }),
        {},
      )
      const expected = await createFeed(without).loadPage(
        params({ filter: 'post' }),
        {},
      )

      expect(page).toEqual(expected)
      expect(withExtra.calls[0]?.values).toEqual(without.calls[0]?.values)
    })
  })

  describe('items', () => {
    it('maps the rows of every kind and folds a group like the activity feed', async () => {
      const database = new FakeQueryExecutor([
        [
          postRow(12, {
            kind: 'project',
            uri: at('org.hypercerts.collection', 'c1'),
          }),
          postRow(11, {
            kind: 'repost',
            uri: at('app.gainforest.feed.repost', 'r1'),
            subject: at('app.gainforest.feed.post', 'subject'),
          }),
          // A recording the followed account does not store but owns.
          postRow(10, {
            kind: 'audio',
            uri: `at://did:plc:uploader/app.gainforest.ac.audio/a10`,
            did: 'did:plc:uploader',
            owner: followed,
            folder: at('app.gainforest.ac.deployment', 'folder'),
          }),
          postRow(9, {
            kind: 'observation',
            uri: at('app.gainforest.dwc.occurrence', 'o9'),
          }),
          postRow(8, {
            kind: 'observation',
            uri: at('app.gainforest.dwc.occurrence', 'o8'),
          }),
          postRow(7, {
            kind: 'observation',
            uri: at('app.gainforest.dwc.occurrence', 'o7'),
          }),
        ],
      ])

      const page = await createFeed(database).loadPage(params(), { limit: 10 })

      expect(page.items.map((item) => item.$type)).toEqual([
        RECORD_ITEM_TYPE,
        REPOST_ITEM_TYPE,
        RECORD_ITEM_TYPE,
        GROUP_ITEM_TYPE,
      ])
      expect(page.items[2]).toMatchObject({
        kind: 'audio',
        did: 'did:plc:uploader',
      })
      expect(page.items[3]).toMatchObject({
        kind: 'observation',
        did: followed,
        total: 3,
      })
      expect(page.uris).toHaveLength(6)
      expect(page.cursor).toBeUndefined()
    })
  })

  // The batch loop is the activity feed's: the statement is still "the next B
  // rows after the cursor".
  describe('batches', () => {
    it('asks for the next rows after the last consumed row and stops at a short batch', async () => {
      const database = new FakeQueryExecutor([
        [postRow(5), postRow(4)],
        [postRow(3), postRow(2)],
        [postRow(1)],
      ])

      const page = await createFeed(database, {
        batchRows: 2,
        requestRows: 100,
      }).loadPage(params(), { limit: 50 })

      expect(page.items).toHaveLength(5)
      expect(page.cursor).toBeUndefined()
      expect(
        database.calls.map(({ values }) => [values[1], values[2], values[3]]),
      ).toEqual([
        [null, null, 2],
        [timeOf(4), at('app.gainforest.feed.post', 'p4'), 2],
        [timeOf(2), at('app.gainforest.feed.post', 'p2'), 2],
      ])
      // Every statement is for the same viewer and the same cap.
      for (const { values } of database.calls) {
        expect(values.slice(4)).toEqual([viewer, MAX_FOLLOWED_ACCOUNTS])
      }
    })

    it('ends the request at the row budget with a following cursor', async () => {
      const database = new FakeQueryExecutor([
        [postRow(4), postRow(3)],
        [postRow(2), postRow(1)],
      ])

      const page = await createFeed(database, {
        batchRows: 2,
        requestRows: 4,
      }).loadPage(params(), { limit: 50 })

      expect(database.calls).toHaveLength(2)
      expect(page.items).toHaveLength(4)
      expect(
        decodeCursor(FOLLOWING_FEED_ID, page.cursor, timestampUriCursor),
      ).toEqual({
        value: timeOf(1),
        uri: at('app.gainforest.feed.post', 'p1'),
      })
    })
  })

  describe('cursor', () => {
    it('is scoped to the feed that issued it', async () => {
      const page = await createFeed(
        new FakeQueryExecutor([[postRow(2), postRow(1)]]),
        { batchRows: 2, requestRows: 2 },
      ).loadPage(params(), { limit: 50 })
      const followingCursor = page.cursor
      expect(followingCursor).toBeDefined()

      const activityPage = await createActivityFeed(
        {
          database: new FakeQueryExecutor([[postRow(2), postRow(1)]]),
          metrics: new Metrics(),
        },
        { batchRows: 2, requestRows: 2 },
      ).loadPage(undefined, { limit: 50 })
      const activityCursor = activityPage.cursor
      expect(activityCursor).toBeDefined()

      // Each feed rejects the other's cursor before it reads anything.
      const followingDatabase = new FakeQueryExecutor([])
      await expect(
        createFeed(followingDatabase).loadPage(params(), {
          cursor: defined(activityCursor),
        }),
      ).rejects.toMatchObject({
        code: FeedErrorCode.InvalidCursor,
        message: expect.stringContaining(
          `cursor belongs to feedId "${ACTIVITY_FEED_ID}", not "${FOLLOWING_FEED_ID}"`,
        ) as unknown,
      })
      const activityDatabase = new FakeQueryExecutor([])
      await expect(
        createActivityFeed({
          database: activityDatabase,
          metrics: new Metrics(),
        }).loadPage(undefined, { cursor: defined(followingCursor) }),
      ).rejects.toMatchObject({
        code: FeedErrorCode.InvalidCursor,
        message: expect.stringContaining(
          `cursor belongs to feedId "${FOLLOWING_FEED_ID}", not "${ACTIVITY_FEED_ID}"`,
        ) as unknown,
      })
      expect(followingDatabase.calls).toEqual([])
      expect(activityDatabase.calls).toEqual([])
    })
  })
})
