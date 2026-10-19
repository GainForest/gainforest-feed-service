import { readFileSync } from 'node:fs'

import type { QueryResultRow } from 'pg'

import { FeedError, FeedErrorCode } from './errors.js'
import type {
  InternalFeedRow,
  InternalSourceFeedRow,
  RegisteredFeed,
} from './registry.js'
import {
  defineSqlFeed,
  type FeedRowMapper,
  type SqlFeedRuntime,
} from './sql-feed.js'
import {
  HYPERCERTS_FEED_ID,
  HYPERCERTS_FEED_PARAMS_TYPE,
  FEED_COLLECTIONS,
  FEED_KINDS,
  type HypercertsFeedParams,
  type FeedKind,
  type OrganizationQuality,
} from './types.js'
import { normalizeFeedRequest } from './validation.js'
import { timestampUriCursor } from './cursor.js'
import { hypercertsFeedParams as hypercertsFeedParamsSchema } from '../lexicons/org/hypercerts/feed/defs.js'

const HYPERCERTS_FEED_QUERY = readFileSync(
  new URL('./feed-query.sql', import.meta.url),
  'utf8',
)
const FEED_KIND_SET = new Set<string>(FEED_KINDS)

interface HypercertsFeedQueryRow extends QueryResultRow {
  readonly uri: string | null
  readonly cid: string | null
  readonly collection: string | null
  readonly actor_did: string | null
  readonly kind: string | null
  readonly sort_value: string | null
  readonly selected_source_uri: string | null
  readonly selected_source_cid: string | null
  readonly selected_source_collection: string | null
  readonly source_json: unknown
}

const metadataInvariantError = (): Error =>
  new Error(
    'Hypercerts feed query metadata invariant failed: a selected row omitted URI, CID, collection, actor DID, kind, or sort value; verify the SQL projection before serving feed requests.',
  )

const sourceInvariantError = (): Error =>
  new Error(
    'Hypercerts feed query source invariant failed: a selected source did not match the exact URI, CID, and collection of its feed row; verify the post-pagination source join before serving hydrated requests.',
  )

const parseSourceRecord = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

const parseHypercertsFeedParams = (
  input: { readonly $type: string },
): HypercertsFeedParams => {
  let parsed: ReturnType<typeof hypercertsFeedParamsSchema.schema.$parse>
  try {
    parsed = hypercertsFeedParamsSchema.schema.$parse(input)
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : ''
    throw new FeedError(
      FeedErrorCode.InvalidRequest,
      `params does not match ${HYPERCERTS_FEED_PARAMS_TYPE}${detail}; correct the feed parameters and retry.`,
      400,
      { cause },
    )
  }

  return {
    $type: HYPERCERTS_FEED_PARAMS_TYPE,
    ...(parsed.viewerDid === undefined ? {} : { viewerDid: parsed.viewerDid }),
    ...(parsed.trustedEvaluators === undefined
      ? {}
      : { trustedEvaluators: parsed.trustedEvaluators }),
    ...(parsed.organizationQuality === undefined
      ? {}
      : {
          organizationQuality: {
            allowed: parsed.organizationQuality.allowed,
            includeUnrated: parsed.organizationQuality.includeUnrated,
          },
        }),
    ...(parsed.kinds === undefined ? {} : { kinds: parsed.kinds }),
  }
}

const mapHypercertsFeedRow: FeedRowMapper<
  HypercertsFeedQueryRow,
  InternalFeedRow
> = (row, mode): InternalFeedRow | InternalSourceFeedRow => {
  if (
    typeof row.uri !== 'string' ||
    typeof row.cid !== 'string' ||
    typeof row.collection !== 'string' ||
    typeof row.actor_did !== 'string' ||
    typeof row.kind !== 'string' ||
    !FEED_KIND_SET.has(row.kind) ||
    typeof row.sort_value !== 'string'
  ) {
    throw metadataInvariantError()
  }

  const metadata: InternalFeedRow = {
    uri: row.uri,
    cid: row.cid,
    collection: row.collection,
    actorDid: row.actor_did,
    kind: row.kind as FeedKind,
    sortValue: row.sort_value,
  }
  if (mode === 'metadata') return metadata

  if (
    row.selected_source_uri !== row.uri ||
    row.selected_source_cid !== row.cid ||
    row.selected_source_collection !== row.collection
  ) {
    throw sourceInvariantError()
  }

  return { ...metadata, sourceValue: parseSourceRecord(row.source_json) }
}

/** Builds the current Hypercerts feed definition over one read-only SQL runtime. */
export const createHypercertsFeed = (
  runtime: SqlFeedRuntime,
  trustedQualityLabelerDids: readonly string[],
): RegisteredFeed =>
  defineSqlFeed(runtime, {
    id: HYPERCERTS_FEED_ID,
    params: {
      type: HYPERCERTS_FEED_PARAMS_TYPE,
      parse: parseHypercertsFeedParams,
      normalize: normalizeFeedRequest,
    },
    sql: HYPERCERTS_FEED_QUERY,
    bind: ({ params, cursor, mode, fetchLimit }) => {
      const policy = params.organizationQuality
      return [
        params.viewerDid,
        params.trustedEvaluators,
        policy !== undefined,
        (policy?.allowed ?? []) satisfies readonly OrganizationQuality[],
        policy?.includeUnrated ?? false,
        trustedQualityLabelerDids,
        params.kinds,
        cursor?.value ?? null,
        cursor?.uri ?? null,
        fetchLimit,
        FEED_COLLECTIONS,
        mode === 'with-source',
      ]
    },
    cursor: timestampUriCursor,
    mapRow: mapHypercertsFeedRow,
  })
