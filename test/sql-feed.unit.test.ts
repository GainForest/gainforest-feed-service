import type { QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import {
  decodeCursor,
  encodeCursor,
  type CursorCodec,
} from '../src/feed/cursor.js'
import { FeedError, FeedErrorCode } from '../src/feed/errors.js'
import type { InternalFeedRow } from '../src/feed/registry.js'
import {
  defineSqlFeed,
  type FeedRowMapper,
  type SqlFeedQueryExecutor,
} from '../src/feed/sql-feed.js'
import { Metrics } from '../src/metrics.js'
import type { FeedParams } from '../src/feed/types.js'

const feedId = 'org.hypercerts.feed.defs#scoredFeed'
const paramsType = 'org.hypercerts.feed.defs#scoredFeedParams'
const otherFeedId = 'org.hypercerts.feed.defs#otherFeed'
const actorDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'

interface ScoredParams {
  readonly $type: typeof paramsType
}

interface NormalizedScoredParams {
  readonly limit: number
  readonly cursor?: string
}

interface ScoredCursor {
  readonly score: number
  readonly uri: string
}

interface ScoredDatabaseRow extends QueryResultRow {
  readonly uri: string
  readonly cid: string
  readonly collection: string
  readonly actor_did: string
  readonly kind: 'cert.create'
  readonly sort_value: string
  readonly score: number
  readonly selected_source_uri: string | null
  readonly selected_source_cid: string | null
  readonly selected_source_collection: string | null
  readonly source_json: unknown
}

interface ScoredFeedRow extends InternalFeedRow {
  readonly score: number
}

class FakeQueryExecutor implements SqlFeedQueryExecutor<ScoredDatabaseRow> {
  readonly calls: {
    readonly text: string
    readonly values: readonly unknown[]
  }[] = []

  constructor(
    readonly rows: readonly ScoredDatabaseRow[],
    private readonly failure?: Error,
  ) {}

  query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly ScoredDatabaseRow[] }> {
    this.calls.push({ text, values })
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve({ rows: this.rows })
  }
}

const scoredCursor: CursorCodec<ScoredCursor, ScoredFeedRow> = {
  decode(value) {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('score' in value) ||
      !('uri' in value) ||
      typeof value.score !== 'number' ||
      typeof value.uri !== 'string'
    ) {
      throw new FeedError(
        FeedErrorCode.InvalidCursor,
        'scored cursor position is invalid; request the first page again.',
      )
    }
    return { score: value.score, uri: value.uri }
  },
  encode: (row) => ({ score: row.score, uri: row.uri }),
}

const mapScoredRow: FeedRowMapper<ScoredDatabaseRow, ScoredFeedRow> = (
  row,
  mode,
) => {
  const metadata: ScoredFeedRow = {
    uri: row.uri,
    cid: row.cid,
    collection: row.collection,
    actorDid: row.actor_did,
    kind: row.kind,
    sortValue: row.sort_value,
    score: row.score,
  }
  if (mode === 'metadata') return metadata
  if (
    row.selected_source_uri !== row.uri ||
    row.selected_source_cid !== row.cid ||
    row.selected_source_collection !== row.collection
  ) {
    throw new Error('source row does not match selected feed row')
  }
  return { ...metadata, sourceValue: row.source_json }
}

const databaseRow = (suffix: string, score: number): ScoredDatabaseRow => {
  const uri = `at://${actorDid}/org.hypercerts.claim.activity/${suffix}`
  return {
    uri,
    cid,
    collection: 'org.hypercerts.claim.activity',
    actor_did: actorDid,
    kind: 'cert.create',
    sort_value: `2026-07-21T10:00:0${String(score)}.000000Z`,
    score,
    selected_source_uri: uri,
    selected_source_cid: cid,
    selected_source_collection: 'org.hypercerts.claim.activity',
    source_json: { score },
  }
}

const parseScoredParams = (input: FeedParams): ScoredParams => {
  if (input.$type !== paramsType) {
    throw new FeedError(
      FeedErrorCode.InvalidRequest,
      'scored feed params type is invalid.',
    )
  }
  return { $type: paramsType }
}

const createFeed = (
  database: SqlFeedQueryExecutor<ScoredDatabaseRow>,
  mapRow: FeedRowMapper<ScoredDatabaseRow, ScoredFeedRow> = mapScoredRow,
) =>
  defineSqlFeed(
    { database, metrics: new Metrics() },
    {
      id: feedId,
      params: {
        type: paramsType,
        parse: parseScoredParams,
        normalize(_params, pagination): NormalizedScoredParams {
          return {
            limit: pagination.limit ?? 2,
            ...(pagination.cursor === undefined
              ? {}
              : { cursor: pagination.cursor }),
          }
        },
      },
      sql: 'SELECT scored feed',
      bind: ({ cursor, mode, fetchLimit }) => [
        cursor?.score ?? null,
        mode === 'with-source',
        fetchLimit,
      ],
      cursor: scoredCursor,
      mapRow,
    },
  )

describe('defineSqlFeed', () => {
  it('runs one query, trims the sentinel, and encodes the selected feed cursor', async () => {
    const database = new FakeQueryExecutor([
      databaseRow('3', 3),
      databaseRow('2', 2),
      databaseRow('1', 1),
    ])
    const feed = createFeed(database)

    const page = await feed.loadPage(
      { $type: paramsType },
      { limit: 2 },
      'metadata',
    )

    expect(page.rows.map((row) => row.uri)).toEqual([
      databaseRow('3', 3).uri,
      databaseRow('2', 2).uri,
    ])
    expect(database.calls).toEqual([
      {
        text: 'SELECT scored feed',
        values: [null, false, 3],
      },
    ])
    expect(decodeCursor(feedId, page.cursor, scoredCursor)).toEqual({
      score: 2,
      uri: databaseRow('2', 2).uri,
    })
  })

  it('maps exact source rows in with-source mode', async () => {
    const source = databaseRow('1', 1)
    const feed = createFeed(new FakeQueryExecutor([source]))

    await expect(
      feed.loadPage({ $type: paramsType }, {}, 'with-source'),
    ).resolves.toEqual({
      rows: [
        {
          uri: source.uri,
          cid,
          collection: source.collection,
          actorDid,
          kind: 'cert.create',
          sortValue: source.sort_value,
          score: 1,
          sourceValue: { score: 1 },
        },
      ],
    })
  })

  it('rejects rows beyond the requested sentinel bound', async () => {
    const feed = createFeed(
      new FakeQueryExecutor([
        databaseRow('3', 3),
        databaseRow('2', 2),
        databaseRow('1', 1),
      ]),
    )

    await expect(
      feed.loadPage({ $type: paramsType }, { limit: 1 }, 'metadata'),
    ).rejects.toThrow(/returned 3 rows after requesting at most 2/i)
  })

  it('rejects a with-source mapper that omits sourceValue', async () => {
    const source = databaseRow('1', 1)
    const feed = createFeed(new FakeQueryExecutor([source]), (row) =>
      mapScoredRow(row, 'metadata'),
    )

    await expect(
      feed.loadPage({ $type: paramsType }, {}, 'with-source'),
    ).rejects.toThrow(/without sourceValue in with-source mode/i)
  })

  it('records database timing when the query rejects', async () => {
    const metrics = new Metrics()
    const failure = new Error('database unavailable')
    const feed = defineSqlFeed(
      { database: new FakeQueryExecutor([], failure), metrics },
      {
        id: feedId,
        params: {
          type: paramsType,
          parse: parseScoredParams,
          normalize: () => ({ limit: 2 }),
        },
        sql: 'SELECT scored feed',
        bind: () => [],
        cursor: scoredCursor,
        mapRow: mapScoredRow,
      },
    )

    await expect(
      feed.loadPage({ $type: paramsType }, {}, 'metadata'),
    ).rejects.toBe(failure)
    expect(await metrics.registry.metrics()).toContain(
      'hypercerts_feed_database_duration_seconds_count{operation="feed"} 1',
    )
  })

  it('rejects another feed cursor before querying', async () => {
    const database = new FakeQueryExecutor([])
    const feed = createFeed(database)
    const cursorRow: ScoredFeedRow = {
      uri: databaseRow('1', 1).uri,
      cid,
      collection: 'org.hypercerts.claim.activity',
      actorDid,
      kind: 'cert.create',
      sortValue: '2026-07-21T10:00:01.000000Z',
      score: 1,
    }
    const cursor = encodeCursor(otherFeedId, cursorRow, scoredCursor)

    await expect(
      feed.loadPage({ $type: paramsType }, { cursor }, 'metadata'),
    ).rejects.toMatchObject({ code: FeedErrorCode.InvalidCursor })
    expect(database.calls).toEqual([])
  })
})
