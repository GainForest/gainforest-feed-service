import { describe, expect, it } from 'vitest'

import { decodeCursor, timestampUriCursor } from '../src/feed/cursor.js'
import { FeedError } from '../src/feed/errors.js'
import {
  BATCH_ROWS,
  REQUEST_ROWS,
  createActivityFeed,
} from '../src/feed/query.js'
import type { ActivityFeedQueryRow } from '../src/feed/query.js'
import type { SqlFeedQueryExecutor } from '../src/feed/sql-feed.js'
import { $output } from '../src/lexicons/app/gainforest/feed/getFeed.js'
import {
  ACTIVITY_FEED_ID,
  ACTIVITY_FEED_PARAMS_TYPE,
  GROUP_ITEM_TYPE,
  RECORD_ITEM_TYPE,
  REPOST_ITEM_TYPE,
} from '../src/feed/types.js'
import { Metrics } from '../src/metrics.js'

const uploaderDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const authorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const at = (collection: string, rkey: string): string =>
  `at://${authorDid}/${collection}/${rkey}`
const folder = at('app.gainforest.ac.deployment', 'folder')
const GROUP_KEY = /^[A-Za-z0-9_-]{22}$/
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

  /** Each response is the rows to return, or the error to reject with. */
  constructor(
    private readonly responses: readonly (
      readonly ActivityFeedQueryRow[] | Error
    )[],
  ) {}

  query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly ActivityFeedQueryRow[] }> {
    this.calls.push({ text, values })
    const rows = this.responses[this.calls.length - 1]
    if (rows === undefined) {
      return Promise.reject(new Error('unexpected extra feed query'))
    }
    if (rows instanceof Error) return Promise.reject(rows)
    return Promise.resolve({ rows })
  }
}

/** The time of the row `index` seconds after 2026-07-21T10:00:00Z, as the statement formats it. */
const timeOf = (index: number): string =>
  new Date(Date.parse('2026-07-21T10:00:00Z') + index * 1_000)
    .toISOString()
    .replace('Z', '000Z')

/** A post row; a larger `index` is newer. */
const postRow = (
  index: number,
  overrides: Partial<ActivityFeedQueryRow> = {},
): ActivityFeedQueryRow => ({
  kind: 'post',
  uri: at('app.gainforest.feed.post', `p${String(index)}`),
  cid,
  did: authorDid,
  sort_value: timeOf(index),
  owner: null,
  folder: null,
  bioacoustic: false,
  subject: null,
  ...overrides,
})

const recordingRow = (
  index: number,
  overrides: Partial<ActivityFeedQueryRow> = {},
): ActivityFeedQueryRow =>
  postRow(index, {
    kind: 'audio',
    uri: at('app.gainforest.ac.audio', `a${String(index)}`),
    owner: authorDid,
    folder,
    ...overrides,
  })

const observationRow = (
  index: number,
  overrides: Partial<ActivityFeedQueryRow> = {},
): ActivityFeedQueryRow =>
  postRow(index, {
    kind: 'observation',
    uri: at('app.gainforest.dwc.occurrence', `o${String(index)}`),
    ...overrides,
  })

/** Rows newest first: `count` posts, numbered from `newest` down. */
const posts = (newest: number, count: number): ActivityFeedQueryRow[] =>
  Array.from({ length: count }, (_, offset) => postRow(newest - offset))

const createFeed = (
  database: FakeQueryExecutor,
  options?: Parameters<typeof createActivityFeed>[1],
) => createActivityFeed({ database, metrics: new Metrics() }, options)

const params = (overrides: Record<string, unknown> = {}) => ({
  $type: ACTIVITY_FEED_PARAMS_TYPE,
  ...overrides,
})

const encodedCursor = (value: Record<string, unknown>, version = 3): string =>
  Buffer.from(
    JSON.stringify({ version, feedId: ACTIVITY_FEED_ID, value }),
  ).toString('base64url')

const cursorOf = (cursor: string | undefined) =>
  decodeCursor(ACTIVITY_FEED_ID, cursor, timestampUriCursor)

describe('activity feed SQL definition', () => {
  it('binds the statement contract for the feed of every kind', async () => {
    const database = new FakeQueryExecutor([[]])
    const feed = createFeed(database)

    await expect(feed.loadPage(params(), { limit: 2 })).resolves.toEqual({
      items: [],
      uris: [],
    })

    expect(feed.id).toBe(ACTIVITY_FEED_ID)
    expect(feed.paramsType).toBe(ACTIVITY_FEED_PARAMS_TYPE)
    expect(database.calls).toHaveLength(1)
    expect(database.calls[0]?.values).toEqual([
      ALL_KINDS,
      null,
      null,
      BATCH_ROWS,
    ])
  })

  it('binds a single kind and the cursor position', async () => {
    const database = new FakeQueryExecutor([[]])
    const position = {
      value: '2026-07-21T10:00:00.000000Z',
      uri: at('app.gainforest.ac.audio', 'o1'),
    }

    await createFeed(database).loadPage(params({ filter: 'audio' }), {
      limit: 10,
      cursor: encodedCursor(position),
    })

    expect(database.calls[0]?.values).toEqual([
      ['audio'],
      position.value,
      position.uri,
      BATCH_ROWS,
    ])
  })

  it('applies the default filter when a request omits params', async () => {
    const database = new FakeQueryExecutor([[]])
    const feed = createFeed(database)

    expect(feed.defaultParams).toEqual({ $type: ACTIVITY_FEED_PARAMS_TYPE })
    await expect(feed.loadPage(undefined, {})).resolves.toEqual({
      items: [],
      uris: [],
    })

    expect(database.calls[0]?.values).toEqual([
      ALL_KINDS,
      null,
      null,
      BATCH_ROWS,
    ])
  })

  // The Lexicon object is open and the feed reads only `filter`, so any other
  // property a caller sends is dropped, whatever its value.
  it.each([
    [
      'following with a viewer',
      { following: true, viewerDid: 'did:plc:ar7c4by46qjdydhdevvrndac' },
    ],
    ['a malformed following', { following: 'yes' }],
    ['a malformed viewer', { viewerDid: 'not-a-did' }],
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
    expect(page.items).toHaveLength(1)
    expect(withExtra.calls[0]?.values).toEqual(without.calls[0]?.values)
    expect(withExtra.calls[0]?.values).toEqual([
      ['post'],
      null,
      null,
      BATCH_ROWS,
    ])
  })

  it('rejects invalid params before querying', async () => {
    const database = new FakeQueryExecutor([])
    const feed = createFeed(database)

    await expect(
      feed.loadPage(params({ filter: 'donation' }), {}),
    ).rejects.toMatchObject({ code: 'InvalidRequest' })
    await expect(
      feed.loadPage(params({ filter: 7 }), {}),
    ).rejects.toMatchObject({ code: 'InvalidRequest', status: 400 })
    expect(database.calls).toEqual([])
  })

  it('uses a batch of 500 rows and a budget of 5,000, which is ten statements', () => {
    expect(BATCH_ROWS).toBe(500)
    expect(REQUEST_ROWS).toBe(5_000)
    expect(REQUEST_ROWS / BATCH_ROWS).toBe(10)
  })

  describe('items', () => {
    it('maps every row shape and folds the rows of a group into one card', async () => {
      const groupTail = at('app.gainforest.dwc.occurrence', 'o1')
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
          observationRow(10),
          recordingRow(9, { did: uploaderDid }),
          observationRow(8),
          observationRow(7),
          observationRow(1),
          postRow(0, {
            kind: 'organization',
            uri: at('x.example.org', 'self'),
          }),
        ],
      ])

      const page = await createFeed(database).loadPage(params(), { limit: 10 })

      expect(page.items).toEqual([
        {
          $type: RECORD_ITEM_TYPE,
          kind: 'project',
          uri: at('org.hypercerts.collection', 'c1'),
          cid,
          did: authorDid,
          createdAt: '2026-07-21T10:00:12.000000Z',
        },
        {
          $type: REPOST_ITEM_TYPE,
          uri: at('app.gainforest.feed.repost', 'r1'),
          cid,
          did: authorDid,
          createdAt: '2026-07-21T10:00:11.000000Z',
          subject: at('app.gainforest.feed.post', 'subject'),
        },
        {
          $type: GROUP_ITEM_TYPE,
          kind: 'observation',
          did: authorDid,
          groupKey: expect.stringMatching(GROUP_KEY) as unknown,
          total: 4,
          from: '2026-07-21T10:00:01.000000Z',
          to: '2026-07-21T10:00:10.000000Z',
          subjects: [
            at('app.gainforest.dwc.occurrence', 'o10'),
            at('app.gainforest.dwc.occurrence', 'o8'),
            at('app.gainforest.dwc.occurrence', 'o7'),
            groupTail,
          ],
        },
        {
          $type: RECORD_ITEM_TYPE,
          kind: 'audio',
          uri: at('app.gainforest.ac.audio', 'a9'),
          cid,
          did: uploaderDid,
          createdAt: '2026-07-21T10:00:09.000000Z',
        },
        {
          $type: RECORD_ITEM_TYPE,
          kind: 'organization',
          uri: at('x.example.org', 'self'),
          cid,
          did: authorDid,
          createdAt: '2026-07-21T10:00:00.000000Z',
        },
      ])
      expect(() => $output.schema.$parse({ feed: page.items })).not.toThrow()
      expect(page.uris).toEqual([
        at('org.hypercerts.collection', 'c1'),
        at('app.gainforest.feed.repost', 'r1'),
        at('app.gainforest.dwc.occurrence', 'o10'),
        at('app.gainforest.dwc.occurrence', 'o8'),
        at('app.gainforest.dwc.occurrence', 'o7'),
        groupTail,
        at('app.gainforest.ac.audio', 'a9'),
        at('x.example.org', 'self'),
      ])
      expect(page.cursor).toBeUndefined()
    })

    it('omits the cid Hyperindex has not stored', async () => {
      const database = new FakeQueryExecutor([
        [
          postRow(2, { cid: null }),
          postRow(1, {
            kind: 'repost',
            uri: at('app.gainforest.feed.repost', 'r1'),
            subject: at('app.gainforest.feed.post', 'subject'),
            cid: null,
          }),
        ],
      ])

      const page = await createFeed(database).loadPage(params(), {})

      expect(page.items).toHaveLength(2)
      for (const item of page.items) expect(item).not.toHaveProperty('cid')
    })

    // `deployment` has `format: at-uri` and the output check is strict. One
    // folder that fails it would answer 500 on every page that holds the
    // recording, so the card names a folder only when it passes. The expected
    // column is written out, not computed, so the table pins the rule.
    describe('the folder of an audio group', () => {
      it.each([
        ['the AT-URI of a folder', folder, true],
        ['a DID alone', `at://${authorDid}`, true],
        [
          'a handle with a collection and a key',
          'at://recorders.example/app.gainforest.ac.deployment/f',
          true,
        ],
        ['an authority that is not a DID or a handle', 'at://did:/x', false],
        [
          'a path that is not a collection and a key',
          `at://${authorDid}/x`,
          false,
        ],
        ['a trailing slash', `${folder}/`, false],
        ['a query', `${folder}?x=1`, false],
        ['a fragment', `${folder}#frag`, false],
        ['a space', `${folder} f`, false],
        ['nothing after the scheme', 'at://', false],
        [
          'a DID over 2,048 characters',
          `at://did:web:${'a'.repeat(2_100)}/app.gainforest.ac.deployment/f`,
          false,
        ],
      ])(
        'names %s only when it is a valid AT-URI',
        async (_name, deployment, named) => {
          const database = new FakeQueryExecutor([
            [3, 2, 1].map((index) =>
              recordingRow(index, { folder: deployment }),
            ),
          ])

          const page = await createFeed(database).loadPage(params(), {})

          const [item] = page.items
          expect(item).toMatchObject({
            $type: GROUP_ITEM_TYPE,
            kind: 'audio',
            did: authorDid,
            total: 3,
            groupKey: expect.stringMatching(GROUP_KEY) as unknown,
          })
          expect(item !== undefined && 'deployment' in item).toBe(named)
          // Whatever a record stores, the page passes the output check.
          expect(() =>
            $output.schema.$parse({ feed: page.items }),
          ).not.toThrow()
        },
      )
    })

    it('omits the deployment of a group of recordings without a folder', async () => {
      const database = new FakeQueryExecutor([
        [3, 2, 1].map((index) => recordingRow(index, { folder: null })),
      ])

      const page = await createFeed(database).loadPage(params(), {})

      expect(page.items[0]).toMatchObject({ $type: GROUP_ITEM_TYPE, total: 3 })
      expect(page.items[0]).not.toHaveProperty('deployment')
    })

    it('gives the same group the same key in two requests', async () => {
      const respond = () =>
        new FakeQueryExecutor([[3, 2, 1].map((index) => recordingRow(index))])

      const first = await createFeed(respond()).loadPage(params(), {})
      const second = await createFeed(respond()).loadPage(params(), {})

      expect(first.items[0]).toHaveProperty('groupKey')
      expect(second.items[0]).toEqual(first.items[0])
    })

    it('keeps record content out of the cursor, so what a record stores cannot grow it', async () => {
      const longDid = `did:web:${'a'.repeat(1_990)}`
      const longFolder = `at://${longDid}/app.gainforest.ac.deployment/x`
      const database = new FakeQueryExecutor([
        [
          ...[3, 2, 1].map((index) =>
            recordingRow(index + 10, { owner: longDid, folder: longFolder }),
          ),
          postRow(0),
        ],
      ])

      const page = await createFeed(database).loadPage(params(), { limit: 1 })

      expect(page.items[0]).toMatchObject({ did: longDid, total: 3 })
      expect(page.cursor?.length).toBeLessThan(400)
    })
  })

  describe('pages', () => {
    it('answers a page from one statement when the first batch fills it', async () => {
      const database = new FakeQueryExecutor([posts(9, 5)])

      const page = await createFeed(database).loadPage(params(), { limit: 2 })

      expect(database.calls).toHaveLength(1)
      expect(page.items).toHaveLength(2)
      expect(cursorOf(page.cursor)).toEqual({
        value: timeOf(8),
        uri: at('app.gainforest.feed.post', 'p8'),
      })
    })

    it('points the cursor at the last row the page consumed, not at its last item', async () => {
      // The page's second card is a post; the rows after it join the first card.
      const database = new FakeQueryExecutor([
        [
          recordingRow(9),
          postRow(8),
          recordingRow(7),
          recordingRow(6),
          recordingRow(5),
          postRow(4),
        ],
      ])

      const page = await createFeed(database).loadPage(params(), { limit: 2 })

      expect(page.items).toHaveLength(2)
      expect(page.items[0]).toMatchObject({ $type: GROUP_ITEM_TYPE, total: 4 })
      expect(cursorOf(page.cursor)).toEqual({
        value: timeOf(5),
        uri: at('app.gainforest.ac.audio', 'a5'),
      })
    })

    it('fetches the next batch after the last consumed row when the page needs more rows', async () => {
      const database = new FakeQueryExecutor([
        posts(9, 3),
        posts(6, 3),
        posts(3, 2),
      ])

      const page = await createFeed(database, { batchRows: 3 }).loadPage(
        params(),
        { limit: 20 },
      )

      expect(database.calls.map((call) => call.values.slice(1))).toEqual([
        [null, null, 3],
        [timeOf(7), at('app.gainforest.feed.post', 'p7'), 3],
        [timeOf(4), at('app.gainforest.feed.post', 'p4'), 3],
      ])
      expect(page.items).toHaveLength(8)
      expect(page.cursor).toBeUndefined()
    })

    it('asks again when a batch is exactly full, and an empty batch ends the page', async () => {
      const database = new FakeQueryExecutor([posts(5, 2), posts(3, 2), []])

      const page = await createFeed(database, { batchRows: 2 }).loadPage(
        params(),
        { limit: 20 },
      )

      expect(database.calls).toHaveLength(3)
      expect(page.items).toHaveLength(4)
      expect(page.cursor).toBeUndefined()
    })

    it('does not fetch again once a row would start a card the page has no room for', async () => {
      const database = new FakeQueryExecutor([posts(9, 3)])

      const page = await createFeed(database, { batchRows: 3 }).loadPage(
        params(),
        { limit: 2 },
      )

      expect(database.calls).toHaveLength(1)
      expect(page.items).toHaveLength(2)
      expect(cursorOf(page.cursor)?.uri).toBe(
        at('app.gainforest.feed.post', 'p8'),
      )
    })

    it('needs the next batch to tell whether the first row of it starts a card', async () => {
      const database = new FakeQueryExecutor([posts(9, 2), posts(7, 2)])

      const page = await createFeed(database, { batchRows: 2 }).loadPage(
        params(),
        { limit: 2 },
      )

      expect(database.calls).toHaveLength(2)
      expect(page.items).toHaveLength(2)
      expect(cursorOf(page.cursor)?.uri).toBe(
        at('app.gainforest.feed.post', 'p8'),
      )
    })

    it('ends at the row budget with a cursor, and says more on a group card that a later row can join', async () => {
      const database = new FakeQueryExecutor([
        [9, 8, 7].map((index) => recordingRow(index)),
        [6, 5, 4].map((index) => recordingRow(index)),
      ])

      const page = await createFeed(database, {
        batchRows: 3,
        requestRows: 6,
      }).loadPage(params(), { limit: 20 })

      expect(database.calls).toHaveLength(2)
      expect(page.items).toMatchObject([
        { $type: GROUP_ITEM_TYPE, total: 6, more: true },
      ])
      expect(cursorOf(page.cursor)).toEqual({
        value: timeOf(4),
        uri: at('app.gainforest.ac.audio', 'a4'),
      })
    })

    it('asks for only the rest of the budget in the last batch', async () => {
      const database = new FakeQueryExecutor([
        [9, 8].map((index) => recordingRow(index)),
        [7, 6].map((index) => recordingRow(index)),
        [5].map((index) => recordingRow(index)),
      ])

      await createFeed(database, { batchRows: 2, requestRows: 5 }).loadPage(
        params(),
        { limit: 20 },
      )

      expect(database.calls.map((call) => call.values[3])).toEqual([2, 2, 1])
    })

    it('says nothing and has no cursor when a short batch ended the page', async () => {
      const database = new FakeQueryExecutor([
        [9, 8, 7].map((index) => recordingRow(index)),
      ])

      const page = await createFeed(database, {
        batchRows: 5,
        requestRows: 5,
      }).loadPage(params(), { limit: 20 })

      expect(page.items[0]).toMatchObject({ total: 3 })
      expect(page.items[0]).not.toHaveProperty('more')
      expect(page.cursor).toBeUndefined()
    })

    it('never runs more statements than the budget allows', async () => {
      const database = new FakeQueryExecutor(
        Array.from({ length: 12 }, (_, batch) =>
          posts(1_000 - batch * 500, 500),
        ),
      )

      // Every post is its own card, so a page of 50 needs a single batch.
      await createFeed(database).loadPage(params(), { limit: 50 })
      expect(database.calls).toHaveLength(1)

      // Rows that all join one group would need every batch; the budget stops it.
      const dump = new FakeQueryExecutor(
        Array.from({ length: 12 }, (_, batch) =>
          Array.from({ length: 500 }, (_, offset) =>
            recordingRow(10_000 - batch * 500 - offset),
          ),
        ),
      )
      const page = await createFeed(dump).loadPage(params(), { limit: 50 })

      expect(dump.calls).toHaveLength(10)
      expect(page.items).toMatchObject([{ total: 5_000, more: true }])
      expect(page.cursor).toBeDefined()
    })

    // The statement formats times with six fractional digits, and the 12-hour
    // rule is exact to the microsecond. Reading them at millisecond precision
    // would join rows that are 12 hours and a few microseconds apart, so these
    // times differ only below the millisecond. The first two rows are a minute
    // apart; the third is placed relative to the second.
    it.each([
      ['rows exactly 12 hours apart join', '2026-07-21T09:59:00.000600Z', true],
      [
        'rows 12 hours less 200 microseconds apart join',
        '2026-07-21T09:59:00.000800Z',
        true,
      ],
      [
        'rows 12 hours and 1 microsecond apart do not join',
        '2026-07-21T09:59:00.000599Z',
        false,
      ],
      [
        'rows 12 hours and 200 microseconds apart do not join',
        '2026-07-21T09:59:00.000400Z',
        false,
      ],
    ])('reads times to the microsecond: %s', async (_name, oldest, joins) => {
      const database = new FakeQueryExecutor([
        [
          observationRow(3, { sort_value: '2026-07-21T22:00:00.000600Z' }),
          observationRow(2, { sort_value: '2026-07-21T21:59:00.000600Z' }),
          observationRow(1, { sort_value: oldest }),
        ],
      ])

      const page = await createFeed(database).loadPage(params(), {})

      expect(page.items.map((item) => item.$type)).toEqual(
        joins
          ? [GROUP_ITEM_TYPE]
          : [RECORD_ITEM_TYPE, RECORD_ITEM_TYPE, RECORD_ITEM_TYPE],
      )
    })

    it('returns an empty page when the statement finds no row', async () => {
      const page = await createFeed(new FakeQueryExecutor([[]])).loadPage(
        params(),
        {},
      )

      expect(page).toEqual({ items: [], uris: [] })
    })

    it('does not hide database failures behind a public error', async () => {
      const timeout = Object.assign(
        new Error('canceling statement due to statement timeout'),
        { code: '57014' },
      )
      const database = new FakeQueryExecutor([timeout])

      const failure = await createFeed(database)
        .loadPage(params(), {})
        .then(
          () => undefined,
          (error: unknown) => error,
        )

      expect(failure).toBe(timeout)
      expect(failure).not.toBeInstanceOf(FeedError)
      expect(database.calls).toHaveLength(1)
    })

    it('does not hide a failure of a later batch', async () => {
      const failure = new Error('connection terminated')
      const database = new FakeQueryExecutor([posts(3, 3), failure])

      await expect(
        createFeed(database, { batchRows: 3 }).loadPage(params(), {
          limit: 20,
        }),
      ).rejects.toBe(failure)
    })
  })

  it.each([
    ['zero', 0],
    ['a fraction', 2.5],
    ['not a number', Number.NaN],
    ['negative', -1],
  ])('rejects a batch of %s rows at construction', (_name, batchRows) => {
    expect(() => createFeed(new FakeQueryExecutor([]), { batchRows })).toThrow(
      'batchRows must be an integer of at least 1',
    )
  })

  it.each([
    ['zero', 0],
    ['a fraction', 2.5],
    ['not a number', Number.NaN],
  ])('rejects a budget of %s rows at construction', (_name, requestRows) => {
    expect(() =>
      createFeed(new FakeQueryExecutor([]), { requestRows }),
    ).toThrow('requestRows must be an integer of at least 1')
  })

  it.each([
    ['a recording without an owner', recordingRow(1, { owner: null })],
    ['a repost without a subject', postRow(1, { kind: 'repost' })],
    ['an unknown kind', postRow(1, { kind: 'donation' })],
    ['an unreadable time', postRow(1, { sort_value: 'yesterday' })],
  ])('fails on %s instead of dropping it', async (_name, row) => {
    const database = new FakeQueryExecutor([[row]])

    await expect(createFeed(database).loadPage(params(), {})).rejects.toThrow(
      'Activity feed query invariant failed',
    )
  })

  it('fails when the statement returns a row newer than the one before it', async () => {
    const database = new FakeQueryExecutor([[postRow(1), postRow(2)]])

    await expect(createFeed(database).loadPage(params(), {})).rejects.toThrow(
      'is newer than the row before it',
    )
  })
})
