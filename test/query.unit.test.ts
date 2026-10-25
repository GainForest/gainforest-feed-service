import { describe, expect, it } from 'vitest'

import { decodeCursor, timestampUriCursor } from '../src/feed/cursor.js'
import { FeedError, FeedErrorCode } from '../src/feed/errors.js'
import { createActivityFeed } from '../src/feed/query.js'
import type { ActivityFeedQueryRow } from '../src/feed/query.js'
import type { SqlFeedQueryExecutor } from '../src/feed/sql-feed.js'
import {
  ACTIVITY_FEED_ID,
  ACTIVITY_FEED_PARAMS_TYPE,
  AUDIO_ITEM_TYPE,
  BURST_ITEM_TYPE,
  RECORD_ITEM_TYPE,
  REPOST_ITEM_TYPE,
} from '../src/feed/types.js'
import { Metrics } from '../src/metrics.js'

const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const authorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const at = (collection: string, rkey: string): string =>
  `at://${authorDid}/${collection}/${rkey}`

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

/** The error node-postgres raises when statement_timeout cancels a statement. */
const statementTimeout = (): Error =>
  Object.assign(new Error('canceling statement due to statement timeout'), {
    code: '57014',
  })

const itemRow = (
  overrides: Partial<ActivityFeedQueryRow>,
): ActivityFeedQueryRow => ({
  complete: true,
  item_no: 1,
  kind: 'post',
  uri: at('app.gainforest.feed.post', 'p1'),
  cid,
  did: authorDid,
  sort_value: '2026-07-21T10:00:05.000000Z',
  subject: null,
  deployment: null,
  day: '2026-07-21',
  total: 1,
  tail_sort_value: '2026-07-21T10:00:05.000000Z',
  tail_uri: at('app.gainforest.feed.post', 'p1'),
  samples: [at('app.gainforest.feed.post', 'p1')],
  ...overrides,
})

const emptyPageRow: ActivityFeedQueryRow = {
  complete: true,
  item_no: null,
  kind: null,
  uri: null,
  cid: null,
  did: null,
  sort_value: null,
  subject: null,
  deployment: null,
  day: null,
  total: null,
  tail_sort_value: null,
  tail_uri: null,
  samples: null,
}

const createFeed = (
  database: FakeQueryExecutor,
  options?: Parameters<typeof createActivityFeed>[1],
) => createActivityFeed({ database, metrics: new Metrics() }, options)

const params = (overrides: Record<string, unknown> = {}) => ({
  $type: ACTIVITY_FEED_PARAMS_TYPE,
  ...overrides,
})

describe('activity feed SQL definition', () => {
  it('binds the statement contract for the unscoped feed', async () => {
    const database = new FakeQueryExecutor([[emptyPageRow]])
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
      512,
      43_200,
      20,
    ])
  })

  it('binds a single kind, the viewer scope, and the decoded cursor', async () => {
    const database = new FakeQueryExecutor([[emptyPageRow]])
    const feed = createFeed(database)
    const position = {
      value: '2026-07-21T10:00:00.000000Z',
      uri: at('app.gainforest.dwc.occurrence', 'o1'),
    }
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        feedId: ACTIVITY_FEED_ID,
        value: position,
      }),
    ).toString('base64url')

    await feed.loadPage(
      params({ filter: 'observation', following: true, viewerDid }),
      { limit: 10, cursor },
    )

    expect(database.calls[0]?.values).toEqual([
      ['observation'],
      true,
      viewerDid,
      position.value,
      position.uri,
      11,
      512,
      43_200,
      20,
    ])
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
          total: 250,
          tail_sort_value: '2026-07-21T09:00:00.000000Z',
          tail_uri: burstTail,
          samples: [at('app.gainforest.dwc.occurrence', 'o8'), burstTail],
        }),
        itemRow({
          item_no: 5,
          kind: 'audio',
          uri: at('app.gainforest.ac.audio', 'a9'),
          sort_value: '2026-07-20T23:00:00.000000Z',
          deployment: at('app.gainforest.ac.deployment', 'folder'),
          day: '2026-07-20',
          total: 90,
          tail_sort_value: '2026-07-20T23:00:00.000000Z',
          tail_uri: at('app.gainforest.ac.audio', 'a9'),
          samples: [at('app.gainforest.ac.audio', 'a9')],
        }),
        // The sentinel only proves that another page exists. Its group
        // details are never computed, so it must not be mapped.
        itemRow({
          item_no: 6,
          kind: 'audio',
          uri: at('app.gainforest.ac.audio', 'a1'),
          total: null,
          samples: null,
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
        total: 250,
        from: '2026-07-21T09:00:00.000000Z',
        to: '2026-07-21T10:00:06.000000Z',
        subjects: [at('app.gainforest.dwc.occurrence', 'o8'), burstTail],
      },
      {
        $type: AUDIO_ITEM_TYPE,
        did: authorDid,
        day: '2026-07-20',
        deployment: at('app.gainforest.ac.deployment', 'folder'),
        total: 90,
        createdAt: '2026-07-20T23:00:00.000000Z',
        subjects: [at('app.gainforest.ac.audio', 'a9')],
      },
    ])
    expect(
      decodeCursor(ACTIVITY_FEED_ID, page.cursor, timestampUriCursor),
    ).toEqual({
      value: '2026-07-20T23:00:00.000000Z',
      uri: at('app.gainforest.ac.audio', 'a9'),
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

  it('omits the optional deployment for an audio group without a folder', async () => {
    const database = new FakeQueryExecutor([
      [
        itemRow({
          kind: 'audio',
          uri: at('app.gainforest.ac.audio', 'a1'),
          deployment: null,
          total: 2,
        }),
      ],
    ])

    const page = await createFeed(database).loadPage(params(), {})

    expect(page.items[0]).not.toHaveProperty('deployment')
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
        itemRow({ item_no: 2 }),
      ],
    ])

    const page = await createFeed(database).loadPage(params(), { limit: 1 })

    expect(
      decodeCursor(ACTIVITY_FEED_ID, page.cursor, timestampUriCursor),
    ).toEqual({ value: '2026-07-21T08:00:00.000000Z', uri: oldest })
  })

  it('repeats the statement with a larger scan window until the page is complete', async () => {
    const database = new FakeQueryExecutor([
      [{ ...emptyPageRow, complete: false }],
      [{ ...emptyPageRow, complete: false }],
      [itemRow({ item_no: 1 })],
    ])

    const page = await createFeed(database).loadPage(params(), {})

    expect(page.items).toHaveLength(1)
    expect(database.calls.map((call) => call.values[6])).toEqual([
      512, 8_192, 131_072,
    ])
  })

  it('fails with a typed, non-retryable error instead of returning a truncated page after the last scan window', async () => {
    const incomplete = [{ ...emptyPageRow, complete: false }]
    const database = new FakeQueryExecutor([
      incomplete,
      incomplete,
      incomplete,
      incomplete,
    ])

    const failure = await createFeed(database)
      .loadPage(params(), {})
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    expect(failure).toBeInstanceOf(FeedError)
    expect(failure).toMatchObject({
      code: FeedErrorCode.ScanLimitExceeded,
      status: 422,
      message: expect.stringContaining('more than 2097152 rows') as unknown,
    })
    expect(failure).toMatchObject({
      message: expect.stringContaining('will not help') as unknown,
    })
    expect(failure).not.toMatchObject({
      message: expect.stringMatching(/retry the request/i) as unknown,
    })
    expect(database.calls).toHaveLength(4)
  })

  it('tries the injected scan windows in order and reports the last one', async () => {
    const incomplete = [{ ...emptyPageRow, complete: false }]
    const database = new FakeQueryExecutor([incomplete, incomplete])

    await expect(
      createFeed(database, { scanRowAttempts: [8, 32] }).loadPage(params(), {}),
    ).rejects.toMatchObject({
      code: FeedErrorCode.ScanLimitExceeded,
      message: expect.stringContaining('more than 32 rows') as unknown,
    })
    expect(database.calls.map((call) => call.values[6])).toEqual([8, 32])
  })

  it('maps a statement timeout on a wider window to the typed ScanLimitExceeded error', async () => {
    const incomplete = [{ ...emptyPageRow, complete: false }]
    const timeout = statementTimeout()
    const database = new FakeQueryExecutor([incomplete, timeout])

    const failure = await createFeed(database)
      .loadPage(params(), {})
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    expect(failure).toBeInstanceOf(FeedError)
    expect(failure).toMatchObject({
      code: FeedErrorCode.ScanLimitExceeded,
      status: 422,
      cause: timeout,
      message: expect.stringContaining('more than 512 rows') as unknown,
    })
    expect(failure).toMatchObject({
      message: expect.stringContaining('8192 rows did not finish') as unknown,
    })
    expect(failure).toMatchObject({
      message: expect.stringContaining('will not help') as unknown,
    })
    // The timed-out window is the last attempt: nothing is retried.
    expect(database.calls.map((call) => call.values[6])).toEqual([512, 8_192])
  })

  it('maps a statement timeout on the last window too', async () => {
    const incomplete = [{ ...emptyPageRow, complete: false }]
    const database = new FakeQueryExecutor([
      incomplete,
      incomplete,
      incomplete,
      statementTimeout(),
    ])

    await expect(
      createFeed(database).loadPage(params(), {}),
    ).rejects.toMatchObject({
      code: FeedErrorCode.ScanLimitExceeded,
      message: expect.stringContaining('more than 131072 rows') as unknown,
    })
  })

  it('leaves a statement timeout on the first window as a plain failure', async () => {
    const timeout = statementTimeout()
    const database = new FakeQueryExecutor([timeout])

    const failure = await createFeed(database)
      .loadPage(params(), {})
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    // A first window that cannot finish is an outage, not a long run.
    expect(failure).toBe(timeout)
    expect(failure).not.toBeInstanceOf(FeedError)
    expect(database.calls).toHaveLength(1)
  })

  it('leaves other database failures on a wider window as plain failures', async () => {
    const incomplete = [{ ...emptyPageRow, complete: false }]
    const connectionLost = Object.assign(new Error('connection lost'), {
      code: '08006',
    })
    const database = new FakeQueryExecutor([incomplete, connectionLost])

    const failure = await createFeed(database)
      .loadPage(params(), {})
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    expect(failure).toBe(connectionLost)
    expect(failure).not.toBeInstanceOf(FeedError)
  })

  it.each([
    ['an empty list', []],
    ['a zero window', [0, 8]],
    ['a fractional window', [8.5]],
    ['windows that do not grow', [32, 8]],
    ['repeated windows', [8, 8]],
  ])('rejects %s of scan windows at construction', (_name, scanRowAttempts) => {
    expect(() =>
      createFeed(new FakeQueryExecutor([]), { scanRowAttempts }),
    ).toThrow(/strictly increasing list of positive integers/)
  })

  it('applies the defaults when a request omits params', async () => {
    const database = new FakeQueryExecutor([[emptyPageRow]])
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
      512,
      43_200,
      20,
    ])
  })

  it.each([
    ['a repost without a subject', { kind: 'repost', subject: null }],
    ['an audio group without a total', { kind: 'audio', total: null }],
    ['a burst without samples', { kind: 'observation', total: 3, samples: [] }],
    ['an unknown kind', { kind: 'donation' }],
  ])('fails on %s instead of dropping it', async (_name, overrides) => {
    const database = new FakeQueryExecutor([[itemRow(overrides)]])

    await expect(createFeed(database).loadPage(params(), {})).rejects.toThrow(
      'Activity feed query invariant failed',
    )
  })

  it('fails when the statement returns no rows at all', async () => {
    await expect(
      createFeed(new FakeQueryExecutor([[]])).loadPage(params(), {}),
    ).rejects.toThrow('returned no rows')
  })
})
