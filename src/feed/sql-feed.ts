import { performance } from 'node:perf_hooks'

import type { QueryResultRow } from 'pg'

import {
  decodeCursor,
  encodeCursor,
  type CursorCodec,
  type OpenGroup,
} from './cursor.js'
import { FeedError, FeedErrorCode } from './errors.js'
import { feedItemKind } from './items.js'
import type { FeedPage, FeedPagination, RegisteredFeed } from './registry.js'
import type { ActivityFeedItem, FeedParams } from './types.js'
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

/** Where the next page continues: strictly after this feed position. */
export interface FeedPosition {
  readonly sortValue: string
  readonly uri: string
  /** The run the page cut at its size limit, so the next page can continue it. */
  readonly group?: OpenGroup
}

/** One selected feed item and the last feed position it consumed. */
export interface SelectedItem {
  readonly item: ActivityFeedItem
  readonly position: FeedPosition
}

/** The items selected for one page, and whether a later page exists. */
export interface SelectedPage {
  readonly items: readonly SelectedItem[]
  readonly hasNext: boolean
}

export interface SqlFeedDefinition<
  Params extends FeedParams,
  Normalized extends NormalizedPageParams,
  Cursor,
  DatabaseRow extends QueryResultRow,
> {
  readonly id: string
  readonly params: {
    readonly type: Params['$type']
    readonly parse: (input: FeedParams) => Params
    readonly normalize: (
      params: Params,
      pagination: FeedPagination,
    ) => Normalized
    /** Params applied when a request omits them; leave unset to require params. */
    readonly default?: Params
  }
  readonly cursor: CursorCodec<Cursor, FeedPosition>
  /**
   * Selects at most `params.limit` items in feed order strictly after
   * `cursor`, and reports whether another item follows them.
   */
  readonly select: (
    database: SqlFeedQueryExecutor<DatabaseRow>,
    input: {
      readonly params: Normalized
      readonly cursor: Cursor | undefined
    },
  ) => Promise<SelectedPage>
}

/** Owns parameter parsing, cursor handling, timing, and metrics around a SQL feed. */
export const defineSqlFeed = <
  Params extends FeedParams,
  Normalized extends NormalizedPageParams,
  Cursor,
  DatabaseRow extends QueryResultRow,
>(
  runtime: SqlFeedRuntime<DatabaseRow>,
  definition: SqlFeedDefinition<Params, Normalized, Cursor, DatabaseRow>,
): RegisteredFeed => {
  async function loadPage(
    params: FeedParams | undefined,
    pagination: FeedPagination,
  ): Promise<FeedPage> {
    const requested = params ?? definition.params.default
    if (requested === undefined) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        `feedId ${JSON.stringify(definition.id)} requires params with $type ${JSON.stringify(definition.params.type)}; provide those params and retry.`,
      )
    }
    if (requested.$type !== definition.params.type) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        `params.$type ${JSON.stringify(requested.$type)} does not match feedId ${JSON.stringify(definition.id)}; use ${JSON.stringify(definition.params.type)} and retry.`,
      )
    }

    const normalized = definition.params.normalize(
      definition.params.parse(requested),
      pagination,
    )
    const cursor = decodeCursor(
      definition.id,
      normalized.cursor,
      definition.cursor,
    )

    const startedAt = performance.now()
    let selected: SelectedPage
    try {
      selected = await definition.select(runtime.database, {
        params: normalized,
        cursor,
      })
    } finally {
      runtime.metrics.observeDatabase(
        'feed',
        (performance.now() - startedAt) / 1_000,
      )
    }

    if (selected.items.length > normalized.limit) {
      throw new Error(
        `Feed query for ${definition.id} selected ${String(selected.items.length)} items for a page limit of ${String(normalized.limit)}; apply the page limit when selecting items.`,
      )
    }
    runtime.metrics.observeResult(
      selected.items.map(({ item }) => feedItemKind(item)),
    )

    const last = selected.items.at(-1)
    return {
      items: selected.items.map(({ item }) => item),
      ...(selected.hasNext && last
        ? {
            cursor: encodeCursor(
              definition.id,
              last.position,
              definition.cursor,
            ),
          }
        : {}),
    }
  }

  return {
    id: definition.id,
    paramsType: definition.params.type,
    ...(definition.params.default === undefined
      ? {}
      : { defaultParams: definition.params.default }),
    loadPage,
  }
}
