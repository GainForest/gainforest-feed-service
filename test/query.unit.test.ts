import { describe, expect, it } from 'vitest'

import { decodeCursor, timestampUriCursor } from '../src/feed/cursor.js'
import { FeedError } from '../src/feed/errors.js'
import { createActivityFeed } from '../src/feed/query.js'
import type { ActivityFeedQueryRow } from '../src/feed/query.js'
import type { SqlFeedQueryExecutor } from '../src/feed/sql-feed.js'
import { $output } from '../src/lexicons/app/gainforest/feed/getFeed.js'
import {
  ACTIVITY_FEED_ID,
  ACTIVITY_FEED_PARAMS_TYPE,
  AUDIO_ITEM_TYPE,
  BURST_ITEM_TYPE,
  MAX_GROUP_ROWS,
  RECORD_ITEM_TYPE,
  REPOST_ITEM_TYPE,
  type ActivityFeedItem,
} from '../src/feed/types.js'
import { Metrics } from '../src/metrics.js'

const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const authorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const at = (collection: string, rkey: string): string =>
  `at://${authorDid}/${collection}/${rkey}`
const folder = at('app.gainforest.ac.deployment', 'folder')
const GROUP_KEY = /^[A-Za-z0-9_-]{22}$/

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

const itemRow = (
  overrides: Partial<ActivityFeedQueryRow>,
): ActivityFeedQueryRow => ({
  item_no: 1,
  kind: 'post',
  uri: at('app.gainforest.feed.post', 'p1'),
  cid,
  did: authorDid,
  sort_value: '2026-07-21T10:00:05.000000Z',
  subject: null,
  deployment: null,
  total: 1,
  tail_sort_value: '2026-07-21T10:00:05.000000Z',
  tail_uri: at('app.gainforest.feed.post', 'p1'),
  samples: [at('app.gainforest.feed.post', 'p1')],
  continued: false,
  capped: false,
  ...overrides,
})

/** The row of an item after the page: it carries no group details. */
const sentinelRow = (
  overrides: Partial<ActivityFeedQueryRow>,
): ActivityFeedQueryRow =>
  itemRow({
    total: null,
    tail_sort_value: null,
    tail_uri: null,
    samples: null,
    ...overrides,
  })

/** A chunk of an audio run: `index` is its position in the run, newest first. */
const audioChunk = (
  index: number,
  overrides: Partial<ActivityFeedQueryRow> = {},
): ActivityFeedQueryRow =>
  itemRow({
    item_no: index + 1,
    kind: 'audio',
    uri: at('app.gainforest.ac.audio', `head${String(index)}`),
    deployment: folder,
    total: MAX_GROUP_ROWS,
    sort_value: `2026-07-21T10:00:0${String(9 - index)}.000000Z`,
    tail_sort_value: `2026-07-21T09:00:0${String(9 - index)}.000000Z`,
    tail_uri: at('app.gainforest.ac.audio', `tail${String(index)}`),
    samples: [at('app.gainforest.ac.audio', `head${String(index)}`)],
    continued: index > 0,
    capped: true,
    ...overrides,
  })

const createFeed = (
  database: FakeQueryExecutor,
  options?: Parameters<typeof createActivityFeed>[1],
) => createActivityFeed({ database, metrics: new Metrics() }, options)

const params = (overrides: Record<string, unknown> = {}) => ({
  $type: ACTIVITY_FEED_PARAMS_TYPE,
  ...overrides,
})

const encodedCursor = (value: Record<string, unknown>): string =>
  Buffer.from(
    JSON.stringify({ version: 2, feedId: ACTIVITY_FEED_ID, value }),
  ).toString('base64url')

const groupKeyOf = (item: ActivityFeedItem | undefined): unknown =>
  item !== undefined && 'groupKey' in item ? item.groupKey : undefined

describe('activity feed SQL definition', () => {
  it('binds the statement contract for the unscoped feed', async () => {
    const database = new FakeQueryExecutor([[]])
    const feed = createFeed(database)

    await expect(feed.loadPage(params(), { limit: 2 })).resolves.toEqual({
      items: [],
    })

    expect(feed.id).toBe(ACTIVITY_FEED_ID)
    expect(feed.paramsType).toBe(ACTIVITY_FEED_PARAMS_TYPE)
    expect(database.calls).toHaveLength(1)
    expect(database.calls[0]?.values).toEqual([
      ['project', 'observation', 'organization', 'post', 'repost', 'audio'],
      false,
      null,
      null,
      null,
      3,
      401,
      43_200,
      20,
      200,
      null,
    ])
  })

  it('binds a single kind, the viewer scope, the cursor, and the kind of the run it left open', async () => {
    const database = new FakeQueryExecutor([[]])
    const feed = createFeed(database)
    const position = {
      value: '2026-07-21T10:00:00.000000Z',
      uri: at('app.gainforest.ac.audio', 'o1'),
      group: { key: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'audio' },
    }

    await feed.loadPage(
      params({ filter: 'audio', following: true, viewerDid }),
      { limit: 10, cursor: encodedCursor(position) },
    )

    expect(database.calls[0]?.values).toEqual([
      ['audio'],
      true,
      viewerDid,
      position.value,
      position.uri,
      11,
      2_001,
      43_200,
      20,
      200,
      'audio',
    ])
  })

  it('binds no open run for a cursor that left none', async () => {
    const database = new FakeQueryExecutor([[]])
    const position = {
      value: '2026-07-21T10:00:00.000000Z',
      uri: at('app.gainforest.dwc.occurrence', 'o1'),
    }

    await createFeed(database).loadPage(params(), {
      cursor: encodedCursor(position),
    })

    expect(database.calls[0]?.values.slice(10)).toEqual([null])
  })

  it.each([
    [1, 201],
    [20, 4_001],
    [50, 10_001],
  ])(
    'reads limit × 200 + 1 rows for a page of %i items',
    async (limit, scanRows) => {
      const database = new FakeQueryExecutor([[]])

      await createFeed(database).loadPage(params(), { limit })

      expect(database.calls[0]?.values[6]).toBe(scanRows)
    },
  )

  it('sizes the scan and the chunks from the configured cap', async () => {
    const database = new FakeQueryExecutor([[]])

    await createFeed(database, { maxGroupRows: 7 }).loadPage(params(), {
      limit: 3,
    })

    expect(database.calls[0]?.values[6]).toBe(22)
    expect(database.calls[0]?.values[9]).toBe(7)
  })

  it('rejects invalid params before querying', async () => {
    const database = new FakeQueryExecutor([])
    const feed = createFeed(database)

    await expect(
      feed.loadPage(params({ filter: 'donation' }), {}),
    ).rejects.toMatchObject({ code: 'InvalidRequest' })
    await expect(
      feed.loadPage(params({ viewerDid: 'not-a-did', following: true }), {}),
    ).rejects.toMatchObject({ code: 'InvalidRequest' })
    await expect(
      feed.loadPage(params({ following: true }), {}),
    ).rejects.toMatchObject({ code: 'InvalidRequest' })
    await expect(
      feed.loadPage(params({ following: 'yes' }), {}),
    ).rejects.toMatchObject({ code: 'InvalidRequest' })
    expect(database.calls).toEqual([])
  })

  it('maps every item shape and trims the sentinel without mapping it', async () => {
    const burstTail = at('app.gainforest.dwc.occurrence', 'o1')
    const database = new FakeQueryExecutor([
      [
        itemRow({
          item_no: 1,
          kind: 'project',
          uri: at('org.hypercerts.collection', 'c1'),
          sort_value: '2026-07-21T10:00:09.000000Z',
        }),
        itemRow({
          item_no: 2,
          kind: 'repost',
          uri: at('app.gainforest.feed.repost', 'r1'),
          subject: at('app.gainforest.feed.post', 'subject'),
          sort_value: '2026-07-21T10:00:08.000000Z',
        }),
        itemRow({
          item_no: 3,
          kind: 'observation',
          uri: at('app.gainforest.dwc.occurrence', 'o9'),
          sort_value: '2026-07-21T10:00:07.000000Z',
          total: 1,
        }),
        itemRow({
          item_no: 4,
          kind: 'observation',
          uri: at('app.gainforest.dwc.occurrence', 'o8'),
          sort_value: '2026-07-21T10:00:06.000000Z',
          total: 150,
          tail_sort_value: '2026-07-21T09:00:00.000000Z',
          tail_uri: burstTail,
          samples: [at('app.gainforest.dwc.occurrence', 'o8'), burstTail],
        }),
        itemRow({
          item_no: 5,
          kind: 'audio',
          uri: at('app.gainforest.ac.audio', 'a9'),
          sort_value: '2026-07-20T23:00:00.000000Z',
          deployment: folder,
          total: 90,
          tail_sort_value: '2026-07-20T22:00:00.000000Z',
          tail_uri: at('app.gainforest.ac.audio', 'a1'),
          samples: [at('app.gainforest.ac.audio', 'a9')],
        }),
        // The sentinel only proves that another page exists. Its group
        // details are never computed, so it must not be mapped.
        sentinelRow({
          item_no: 6,
          kind: 'audio',
          uri: at('app.gainforest.ac.audio', 'a0'),
        }),
      ],
    ])
    const feed = createFeed(database)

    const page = await feed.loadPage(params(), { limit: 5 })

    expect(page.items).toEqual([
      {
        $type: RECORD_ITEM_TYPE,
        kind: 'project',
        uri: at('org.hypercerts.collection', 'c1'),
        cid,
        did: authorDid,
        createdAt: '2026-07-21T10:00:09.000000Z',
      },
      {
        $type: REPOST_ITEM_TYPE,
        uri: at('app.gainforest.feed.repost', 'r1'),
        cid,
        did: authorDid,
        createdAt: '2026-07-21T10:00:08.000000Z',
        subject: at('app.gainforest.feed.post', 'subject'),
      },
      {
        $type: RECORD_ITEM_TYPE,
        kind: 'observation',
        uri: at('app.gainforest.dwc.occurrence', 'o9'),
        cid,
        did: authorDid,
        createdAt: '2026-07-21T10:00:07.000000Z',
      },
      {
        $type: BURST_ITEM_TYPE,
        did: authorDid,
        total: 150,
        from: '2026-07-21T09:00:00.000000Z',
        to: '2026-07-21T10:00:06.000000Z',
        subjects: [at('app.gainforest.dwc.occurrence', 'o8'), burstTail],
        groupKey: expect.stringMatching(GROUP_KEY) as unknown,
        continued: false,
        capped: false,
      },
      {
        $type: AUDIO_ITEM_TYPE,
        did: authorDid,
        deployment: folder,
        total: 90,
        from: '2026-07-20T22:00:00.000000Z',
        to: '2026-07-20T23:00:00.000000Z',
        subjects: [at('app.gainforest.ac.audio', 'a9')],
        groupKey: expect.stringMatching(GROUP_KEY) as unknown,
        continued: false,
        capped: false,
      },
    ])
    expect(
      decodeCursor(ACTIVITY_FEED_ID, page.cursor, timestampUriCursor),
    ).toEqual({
      value: '2026-07-20T22:00:00.000000Z',
      uri: at('app.gainforest.ac.audio', 'a1'),
    })
  })

  it('omits the cid Hyperindex has not stored', async () => {
    const database = new FakeQueryExecutor([
      [
        itemRow({ item_no: 1, cid: null }),
        itemRow({
          item_no: 2,
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

  it('omits the optional deployment for an audio item without a folder', async () => {
    const database = new FakeQueryExecutor([
      [audioChunk(0, { deployment: null, capped: false, total: 2 })],
    ])

    const page = await createFeed(database).loadPage(params(), {})

    expect(page.items[0]).not.toHaveProperty('deployment')
  })

  // `deployment` has `format: at-uri` and the output check is strict. One
  // folder that fails it would answer 500 on every page that holds the
  // recording, so the item names a folder only when it passes. The expected
  // column is written out, not computed, so the table pins the rule.
  describe('the folder of an audio item', () => {
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
          [audioChunk(0, { deployment, capped: false, total: 2 })],
        ])

        const page = await createFeed(database).loadPage(params(), {})

        const [item] = page.items
        expect(item).toMatchObject({
          $type: AUDIO_ITEM_TYPE,
          did: authorDid,
          total: 2,
          groupKey: expect.stringMatching(GROUP_KEY) as unknown,
        })
        expect(item !== undefined && 'deployment' in item).toBe(named)
        // Whatever a record stores, the page passes the output check.
        expect(() => $output.schema.$parse({ feed: page.items })).not.toThrow()
      },
    )
  })

  it('returns an empty page when the statement finds no item', async () => {
    const page = await createFeed(new FakeQueryExecutor([[]])).loadPage(
      params(),
      {},
    )

    expect(page).toEqual({ items: [] })
  })

  it('moves the cursor past the whole burst, to its oldest member', async () => {
    const oldest = at('app.gainforest.dwc.occurrence', 'oldest')
    const database = new FakeQueryExecutor([
      [
        itemRow({
          item_no: 1,
          kind: 'observation',
          uri: at('app.gainforest.dwc.occurrence', 'newest'),
          total: 40,
          tail_sort_value: '2026-07-21T08:00:00.000000Z',
          tail_uri: oldest,
        }),
        sentinelRow({ item_no: 2 }),
      ],
    ])

    const page = await createFeed(database).loadPage(params(), { limit: 1 })

    expect(
      decodeCursor(ACTIVITY_FEED_ID, page.cursor, timestampUriCursor),
    ).toEqual({ value: '2026-07-21T08:00:00.000000Z', uri: oldest })
  })

  describe('runs cut at the cap', () => {
    it('gives every chunk of a run the key of its first chunk and another run a new one', async () => {
      const database = new FakeQueryExecutor([
        [
          audioChunk(0),
          audioChunk(1),
          audioChunk(2, { total: 3, capped: false }),
          audioChunk(3, {
            uri: at('app.gainforest.ac.audio', 'other-run'),
            continued: false,
            total: 5,
            capped: false,
          }),
        ],
      ])

      const { items } = await createFeed(database).loadPage(params(), {})

      const keys = items.map(groupKeyOf)
      expect(keys[0]).toMatch(GROUP_KEY)
      expect(keys[1]).toBe(keys[0])
      expect(keys[2]).toBe(keys[0])
      expect(keys[3]).toMatch(GROUP_KEY)
      expect(keys[3]).not.toBe(keys[0])
      expect(
        items.map((item) => 'continued' in item && item.continued),
      ).toEqual([false, true, true, false])
      expect(items.map((item) => 'capped' in item && item.capped)).toEqual([
        true,
        true,
        false,
        false,
      ])
    })

    it('derives the key from the run, so a later request names the same run the same way', async () => {
      const respond = () => new FakeQueryExecutor([[audioChunk(0)]])

      const first = await createFeed(respond()).loadPage(params(), {})
      const second = await createFeed(respond()).loadPage(params(), {})

      expect(groupKeyOf(first.items[0])).toMatch(GROUP_KEY)
      expect(groupKeyOf(second.items[0])).toBe(groupKeyOf(first.items[0]))
    })

    it('puts the run a page cut into the cursor with its key, so the next page continues it', async () => {
      const database = new FakeQueryExecutor([
        [audioChunk(0), sentinelRow({ item_no: 2, kind: 'audio' })],
      ])

      const page = await createFeed(database).loadPage(params(), { limit: 1 })

      expect(
        decodeCursor(ACTIVITY_FEED_ID, page.cursor, timestampUriCursor),
      ).toEqual({
        value: '2026-07-21T09:00:09.000000Z',
        uri: at('app.gainforest.ac.audio', 'tail0'),
        group: { key: groupKeyOf(page.items[0]), kind: 'audio' },
      })
    })

    it('keeps record content out of the cursor, so what a record stores cannot grow it', async () => {
      const longDid = `did:web:${'a'.repeat(1_990)}`
      const database = new FakeQueryExecutor([
        [
          audioChunk(0, {
            did: longDid,
            deployment: `at://${longDid}/app.gainforest.ac.deployment/x`,
          }),
          sentinelRow({ item_no: 2, kind: 'audio' }),
        ],
      ])

      const page = await createFeed(database).loadPage(params(), { limit: 1 })

      expect(page.items[0]).toMatchObject({ did: longDid })
      expect(page.cursor?.length).toBeLessThan(600)
      expect(
        decodeCursor(ACTIVITY_FEED_ID, page.cursor, timestampUriCursor),
      ).toMatchObject({
        group: { key: groupKeyOf(page.items[0]), kind: 'audio' },
      })
    })

    it('puts a burst a page cut into the cursor in the same way', async () => {
      const database = new FakeQueryExecutor([
        [
          itemRow({
            kind: 'observation',
            uri: at('app.gainforest.dwc.occurrence', 'head'),
            total: MAX_GROUP_ROWS,
            capped: true,
            tail_uri: at('app.gainforest.dwc.occurrence', 'tail'),
          }),
          sentinelRow({ item_no: 2, kind: 'observation' }),
        ],
      ])

      const page = await createFeed(database).loadPage(params(), { limit: 1 })

      expect(
        decodeCursor(ACTIVITY_FEED_ID, page.cursor, timestampUriCursor),
      ).toEqual({
        value: '2026-07-21T10:00:05.000000Z',
        uri: at('app.gainforest.dwc.occurrence', 'tail'),
        group: { key: groupKeyOf(page.items[0]), kind: 'observation' },
      })
    })

    it('leaves the cursor without a run when the last chunk ended its run', async () => {
      const database = new FakeQueryExecutor([
        [
          audioChunk(1, { capped: false, total: 12 }),
          sentinelRow({ item_no: 2, kind: 'observation' }),
        ],
      ])

      const page = await createFeed(database).loadPage(params(), {
        limit: 1,
        cursor: encodedCursor({
          value: '2026-07-21T11:00:00.000000Z',
          uri: at('app.gainforest.ac.audio', 'before'),
          group: { key: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'audio' },
        }),
      })

      const decoded = decodeCursor(
        ACTIVITY_FEED_ID,
        page.cursor,
        timestampUriCursor,
      )
      expect(decoded).not.toHaveProperty('group')
    })

    it('keeps the key of the run the cursor left open for the first chunk of the page', async () => {
      const database = new FakeQueryExecutor([
        [audioChunk(1, { capped: false, total: 12 })],
      ])

      const page = await createFeed(database).loadPage(params(), {
        cursor: encodedCursor({
          value: '2026-07-21T11:00:00.000000Z',
          uri: at('app.gainforest.ac.audio', 'before'),
          group: { key: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'audio' },
        }),
      })

      expect(page.items[0]).toMatchObject({
        $type: AUDIO_ITEM_TYPE,
        continued: true,
        capped: false,
        groupKey: 'AAAAAAAAAAAAAAAAAAAAAA',
      })
    })

    it('keeps a one-row continuation a burst, so clients merge it into the run', async () => {
      const database = new FakeQueryExecutor([
        [
          itemRow({
            kind: 'observation',
            uri: at('app.gainforest.dwc.occurrence', 'last'),
            total: 1,
            continued: true,
          }),
        ],
      ])

      const page = await createFeed(database).loadPage(params(), {
        cursor: encodedCursor({
          value: '2026-07-21T11:00:00.000000Z',
          uri: at('app.gainforest.dwc.occurrence', 'before'),
          group: { key: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'observation' },
        }),
      })

      expect(page.items[0]).toMatchObject({
        $type: BURST_ITEM_TYPE,
        total: 1,
        continued: true,
        groupKey: 'AAAAAAAAAAAAAAAAAAAAAA',
      })
    })

    it('keeps a lone first observation a record item', async () => {
      const database = new FakeQueryExecutor([
        [
          itemRow({
            kind: 'observation',
            uri: at('app.gainforest.dwc.occurrence', 'lone'),
            total: 1,
          }),
        ],
      ])

      const page = await createFeed(database).loadPage(params(), {})

      expect(page.items[0]).toMatchObject({ $type: RECORD_ITEM_TYPE })
    })

    it('fails when a chunk continues a run that nothing names', async () => {
      const database = new FakeQueryExecutor([[audioChunk(1)]])

      await expect(createFeed(database).loadPage(params(), {})).rejects.toThrow(
        'Activity feed query invariant failed',
      )
    })

    it('does not continue a run across an item that is not part of it', async () => {
      const database = new FakeQueryExecutor([
        [audioChunk(0), itemRow({ item_no: 2 }), audioChunk(2)],
      ])

      await expect(createFeed(database).loadPage(params(), {})).rejects.toThrow(
        'continues a run that neither the previous item nor the cursor names',
      )
    })
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

  it.each([
    ['zero', 0],
    ['one', 1],
    ['a fraction', 2.5],
    ['not a number', Number.NaN],
  ])('rejects a group cap of %s at construction', (_name, maxGroupRows) => {
    expect(() =>
      createFeed(new FakeQueryExecutor([]), { maxGroupRows }),
    ).toThrow('maxGroupRows must be an integer of at least 2')
  })

  it('applies the defaults when a request omits params', async () => {
    const database = new FakeQueryExecutor([[]])
    const feed = createFeed(database)

    expect(feed.defaultParams).toEqual({ $type: ACTIVITY_FEED_PARAMS_TYPE })
    await expect(feed.loadPage(undefined, {})).resolves.toEqual({ items: [] })

    expect(database.calls[0]?.values).toEqual([
      ['project', 'observation', 'organization', 'post', 'repost', 'audio'],
      false,
      null,
      null,
      null,
      21,
      4_001,
      43_200,
      20,
      200,
      null,
    ])
  })

  it.each([
    ['a repost without a subject', { kind: 'repost', subject: null }],
    ['a burst without samples', { kind: 'observation', total: 3, samples: [] }],
    ['an audio item without samples', { kind: 'audio', samples: null }],
    ['an unknown kind', { kind: 'donation' }],
    ['an item without a row count', { total: null }],
    ['an item without a last row', { tail_uri: null }],
  ])('fails on %s instead of dropping it', async (_name, overrides) => {
    const database = new FakeQueryExecutor([[itemRow(overrides)]])

    await expect(createFeed(database).loadPage(params(), {})).rejects.toThrow(
      'Activity feed query invariant failed',
    )
  })
})
