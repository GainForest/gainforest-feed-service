import { performance } from 'node:perf_hooks'

import type { QueryResultRow } from 'pg'

import { decodeCursor, encodeCursor, type CursorCodec } from './cursor.js'
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
}

/** One selected feed item and the AT-URIs of every record it covers. */
export interface SelectedItem {
  readonly item: ActivityFeedItem
  /** The records the item covers, newest first; a skeleton lists all of them. */
  readonly uris: readonly string[]
}

/**
 * The items selected for one page. `next` is the last row the page consumed,
 * and is present only when another page can follow.
 */
export interface SelectedPage {
  readonly items: readonly SelectedItem[]
  readonly next?: FeedPosition
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
   * Selects the page's items in feed order strictly after `cursor`. The feed
   * decides how many items a page holds and where the next page starts.
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

    runtime.metrics.observeResult(
      selected.items.map(({ item }) => feedItemKind(item)),
    )

    return {
      items: selected.items.map(({ item }) => item),
      uris: selected.items.flatMap(({ uris }) => uris),
      ...(selected.next === undefined
        ? {}
        : {
            cursor: encodeCursor(
              definition.id,
              selected.next,
              definition.cursor,
            ),
          }),
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
