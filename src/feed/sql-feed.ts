import { performance } from 'node:perf_hooks'

import type { QueryResultRow } from 'pg'

import { decodeCursor, encodeCursor, type CursorCodec } from './cursor.js'
import { FeedError, FeedErrorCode } from './errors.js'
import type {
  FeedPageMode,
  FeedPagination,
  InternalFeedPage,
  InternalFeedRow,
  InternalSourceFeedRow,
  RegisteredFeed,
} from './registry.js'
import type { FeedParams } from './types.js'
import type { Metrics } from '../metrics.js'

export interface NormalizedPageParams {
  readonly limit: number
  readonly cursor?: string
}

export interface SqlFeedQueryExecutor<Row extends QueryResultRow> {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>
}

export interface SqlFeedRuntime<Row extends QueryResultRow> {
  readonly database: SqlFeedQueryExecutor<Row>
  readonly metrics: Metrics
}

const hasSourceValue = <Row extends InternalFeedRow>(
  row: Row | (Row & InternalSourceFeedRow),
): row is Row & InternalSourceFeedRow =>
  Object.prototype.hasOwnProperty.call(row, 'sourceValue')

export type FeedRowMapper<DatabaseRow, FeedRow extends InternalFeedRow> = (
  row: DatabaseRow,
  mode: FeedPageMode,
) => FeedRow | (FeedRow & InternalSourceFeedRow)

export interface SqlFeedDefinition<
  Params extends FeedParams,
  Normalized extends NormalizedPageParams,
  Cursor,
  DatabaseRow extends QueryResultRow,
  FeedRow extends InternalFeedRow,
> {
  readonly id: string
  readonly params: {
    readonly type: Params['$type']
    readonly parse: (input: FeedParams) => Params
    readonly normalize: (
      params: Params,
      pagination: FeedPagination,
    ) => Normalized
  }
  readonly sql: string
  readonly bind: (input: {
    readonly params: Normalized
    readonly cursor: Cursor | undefined
    readonly mode: FeedPageMode
    readonly fetchLimit: number
  }) => readonly unknown[]
  readonly cursor: CursorCodec<Cursor, FeedRow>
  readonly mapRow: FeedRowMapper<DatabaseRow, FeedRow>
}

export const defineSqlFeed = <
  Params extends FeedParams,
  Normalized extends NormalizedPageParams,
  Cursor,
  DatabaseRow extends QueryResultRow,
  FeedRow extends InternalFeedRow,
>(
  runtime: SqlFeedRuntime<DatabaseRow>,
  definition: SqlFeedDefinition<
    Params,
    Normalized,
    Cursor,
    DatabaseRow,
    FeedRow
  >,
): RegisteredFeed => {
  const finishPage = <Row extends FeedRow>(
    rows: readonly Row[],
    normalized: Normalized,
    fetchLimit: number,
  ): InternalFeedPage<Row> => {
    if (rows.length > fetchLimit) {
      throw new Error(
        `Feed query for ${definition.id} returned ${String(rows.length)} rows after requesting at most ${String(fetchLimit)}; apply the registered limit inside the SQL statement.`,
      )
    }

    const hasNext = rows.length > normalized.limit
    const page = hasNext ? rows.slice(0, normalized.limit) : rows
    runtime.metrics.observeResult(page.map((row) => row.kind))

    const last = page.at(-1)
    return {
      rows: page,
      ...(hasNext && last
        ? {
            cursor: encodeCursor(definition.id, last, definition.cursor),
          }
        : {}),
    }
  }

  function loadPage(
    params: FeedParams | undefined,
    pagination: FeedPagination,
    mode: 'metadata',
  ): Promise<InternalFeedPage<InternalFeedRow>>
  function loadPage(
    params: FeedParams | undefined,
    pagination: FeedPagination,
    mode: 'with-source',
  ): Promise<InternalFeedPage<InternalSourceFeedRow>>
  async function loadPage(
    params: FeedParams | undefined,
    pagination: FeedPagination,
    mode: FeedPageMode,
  ): Promise<InternalFeedPage<InternalFeedRow | InternalSourceFeedRow>> {
    if (params === undefined) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        `feedId ${JSON.stringify(definition.id)} requires params with $type ${JSON.stringify(definition.params.type)}; provide those params and retry.`,
      )
    }
    if (params.$type !== definition.params.type) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        `params.$type ${JSON.stringify(params.$type)} does not match feedId ${JSON.stringify(definition.id)}; use ${JSON.stringify(definition.params.type)} and retry.`,
      )
    }

    const parsed = definition.params.parse(params)
    const normalized = definition.params.normalize(parsed, pagination)
    const cursor = decodeCursor(
      definition.id,
      normalized.cursor,
      definition.cursor,
    )
    const fetchLimit = normalized.limit + 1
    const values = definition.bind({
      params: normalized,
      cursor,
      mode,
      fetchLimit,
    })

    const startedAt = performance.now()
    let result: { readonly rows: readonly DatabaseRow[] }
    try {
      result = await runtime.database.query(definition.sql, values)
    } finally {
      runtime.metrics.observeDatabase(
        'feed',
        (performance.now() - startedAt) / 1_000,
      )
    }

    if (mode === 'metadata') {
      const rows = result.rows.map((row) => definition.mapRow(row, 'metadata'))
      return finishPage(rows, normalized, fetchLimit)
    }

    const rows = result.rows.map((row) => {
      const mapped = definition.mapRow(row, 'with-source')
      if (!hasSourceValue(mapped)) {
        throw new Error(
          `Feed row mapper for ${definition.id} returned metadata without sourceValue in with-source mode; return the exact selected source or reject the row.`,
        )
      }
      return mapped
    })
    return finishPage(rows, normalized, fetchLimit)
  }

  return {
    id: definition.id,
    paramsType: definition.params.type,
    loadPage,
  }
}
