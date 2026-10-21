import { describe, expect, it } from 'vitest'

import { createHypercertsFeed } from '../src/feed/query.js'
import type { SqlFeedQueryExecutor } from '../src/feed/sql-feed.js'
import { FEED_COLLECTIONS } from '../src/feed/types.js'
import { Metrics } from '../src/metrics.js'

const feedId = 'org.hypercerts.feed.defs#hypercertsFeed'
const paramsType = 'org.hypercerts.feed.defs#hypercertsFeedParams'
const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const trustedLabeler = 'did:plc:ragtjsm2j2vknwkz3zp4oxrd'
const uri = `at://${actorDid}/org.hypercerts.claim.activity/3kpn`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'

type HypercertsFeedQueryRow =
  Parameters<
    typeof createHypercertsFeed
  >[0]['database'] extends SqlFeedQueryExecutor<infer Row>
    ? Row
    : never

class FakeQueryExecutor implements SqlFeedQueryExecutor<HypercertsFeedQueryRow> {
  readonly calls: {
    readonly text: string
    readonly values: readonly unknown[]
  }[] = []

  constructor(private readonly rows: readonly HypercertsFeedQueryRow[]) {}

  query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly HypercertsFeedQueryRow[] }> {
    this.calls.push({ text, values })
    return Promise.resolve({ rows: this.rows })
  }
}

const resultRow = (
  overrides: Partial<HypercertsFeedQueryRow> = {},
): HypercertsFeedQueryRow => ({
  uri,
  cid,
  collection: 'org.hypercerts.claim.activity',
  actor_did: actorDid,
  kind: 'cert.create',
  sort_value: '2026-07-21T10:00:00.000000Z',
  selected_source_uri: uri,
  selected_source_cid: cid,
  selected_source_collection: 'org.hypercerts.claim.activity',
  source_json: '{"title":"Source"}',
  ...overrides,
})

const params = {
  $type: paramsType,
  viewerDid,
} as const

describe('Hypercerts SQL feed definition', () => {
  it('binds the current feed contract and maps metadata rows', async () => {
    const database = new FakeQueryExecutor([
      resultRow({
        selected_source_uri: null,
        selected_source_cid: null,
        selected_source_collection: null,
        source_json: null,
      }),
    ])
    const feed = createHypercertsFeed({ database, metrics: new Metrics() }, [
      trustedLabeler,
    ])

    await expect(
      feed.loadPage(params, { limit: 2 }, 'metadata'),
    ).resolves.toEqual({
      rows: [
        {
          uri,
          cid,
          collection: 'org.hypercerts.claim.activity',
          actorDid,
          kind: 'cert.create',
          sortValue: '2026-07-21T10:00:00.000000Z',
        },
      ],
    })
    expect(feed.id).toBe(feedId)
    expect(feed.paramsType).toBe(paramsType)
    expect(database.calls).toHaveLength(1)
    expect(database.calls[0]?.values).toEqual([
      viewerDid,
      [],
      false,
      [],
      false,
      [trustedLabeler],
      [],
      null,
      null,
      3,
      FEED_COLLECTIONS,
      false,
    ])
  })

  it('rejects structural and semantic params failures before querying', async () => {
    const database = new FakeQueryExecutor([])
    const feed = createHypercertsFeed({ database, metrics: new Metrics() }, [])

    const invalidViewerRequest = feed.loadPage(
      { $type: paramsType },
      {},
      'metadata',
    )
    await expect(invalidViewerRequest).rejects.toThrow(
      /viewerDid is not a valid DID/,
    )
    await expect(invalidViewerRequest).rejects.toMatchObject({
      code: 'InvalidRequest',
    })
    await expect(
      feed.loadPage(
        {
          $type: paramsType,
          viewerDid: 'not-a-did',
        },
        {},
        'metadata',
      ),
    ).rejects.toMatchObject({ code: 'InvalidRequest' })
    expect(database.calls).toEqual([])
  })

  it('maps exact selected sources in with-source mode', async () => {
    const sourceValue = { title: 'Exact source' }
    const database = new FakeQueryExecutor([
      resultRow({ source_json: JSON.stringify(sourceValue) }),
    ])
    const feed = createHypercertsFeed({ database, metrics: new Metrics() }, [])

    await expect(
      feed.loadPage(params, { limit: 2 }, 'with-source'),
    ).resolves.toEqual({
      rows: [
        {
          uri,
          cid,
          collection: 'org.hypercerts.claim.activity',
          actorDid,
          kind: 'cert.create',
          sortValue: '2026-07-21T10:00:00.000000Z',
          sourceValue,
        },
      ],
    })
    expect(database.calls[0]?.values[11]).toBe(true)
    const sql = database.calls[0]?.text ?? ''
    expect(
      sql.indexOf('selected_source.record AS source_json'),
    ).toBeGreaterThan(sql.indexOf('paged_events AS'))
    expect(sql).toContain('ON $12::boolean')
    expect(sql).toContain('selected_source.uri = page.uri')
    expect(sql).toContain('selected_source.cid = page.cid')
    const classifiedProjection = sql.slice(
      sql.indexOf('classified_events AS'),
      sql.indexOf('filtered_events AS'),
    )
    expect(classifiedProjection).toContain('source.collection')
    expect(classifiedProjection).not.toContain('source.json AS source_json')
  })

  it('treats malformed source JSON as invalid source data', async () => {
    const invalidFeed = createHypercertsFeed(
      {
        database: new FakeQueryExecutor([resultRow({ source_json: '{' })]),
        metrics: new Metrics(),
      },
      [],
    )

    const invalidPage = await invalidFeed.loadPage(params, {}, 'with-source')
    expect(invalidPage.rows[0]?.sourceValue).toBeUndefined()
  })

  it.each([
    { uri: null },
    { cid: null },
    { collection: null },
    { actor_did: null },
    { kind: null },
    { sort_value: null },
  ])(
    'fails instead of silently dropping incomplete metadata: %o',
    async (overrides) => {
      const feed = createHypercertsFeed(
        {
          database: new FakeQueryExecutor([resultRow(overrides)]),
          metrics: new Metrics(),
        },
        [],
      )

      await expect(
        feed.loadPage(params, { limit: 2 }, 'metadata'),
      ).rejects.toThrow('metadata invariant failed')
    },
  )

  it('preserves a present JSON null source value', async () => {
    const feed = createHypercertsFeed(
      {
        database: new FakeQueryExecutor([resultRow({ source_json: 'null' })]),
        metrics: new Metrics(),
      },
      [],
    )

    const page = await feed.loadPage(params, {}, 'with-source')

    expect(page.rows[0]).toHaveProperty('sourceValue', null)
  })

  it.each([
    { selected_source_uri: null },
    { selected_source_uri: `${uri}-other` },
    { selected_source_cid: null },
    { selected_source_cid: 'bafyreimismatch' },
    { selected_source_collection: null },
    { selected_source_collection: 'org.hypercerts.collection' },
  ])(
    'rejects a missing or mismatched selected source: %o',
    async (overrides) => {
      const feed = createHypercertsFeed(
        {
          database: new FakeQueryExecutor([resultRow(overrides)]),
          metrics: new Metrics(),
        },
        [],
      )

      await expect(
        feed.loadPage(params, { limit: 2 }, 'with-source'),
      ).rejects.toThrow('source invariant failed')
    },
  )
})
