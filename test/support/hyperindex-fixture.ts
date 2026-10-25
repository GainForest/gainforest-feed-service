import { randomBytes } from 'node:crypto'

import { Pool } from 'pg'

import type { ActivityFeedQueryRow } from '../../src/feed/query.js'
import type { SqlFeedQueryExecutor } from '../../src/feed/sql-feed.js'

const plcAlphabet = 'abcdefghijklmnopqrstuvwxyz234567'

/** A syntactically valid, random did:plc identifier. */
export const randomDid = (): string => {
  let suffix = ''
  for (const byte of randomBytes(24)) {
    suffix += plcAlphabet.charAt(byte % plcAlphabet.length)
  }
  return `did:plc:${suffix}`
}

export const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'

/**
 * The slice of Hyperindex's `record` table (migrations 001, 002, 006, 010, 012
 * and 014) that the feed reads. The fixture creates it only when the database
 * has no `record` table yet, so a database migrated by Hyperindex itself is
 * used as it is.
 */
const RECORD_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS public.record (
    uri TEXT PRIMARY KEY NOT NULL,
    cid TEXT NOT NULL,
    did TEXT NOT NULL,
    collection TEXT NOT NULL,
    json JSONB NOT NULL,
    indexed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    rkey TEXT GENERATED ALWAYS AS (substring(uri from '[^/]+$')) STORED,
    record_created_at TIMESTAMP WITH TIME ZONE,
    validation_status TEXT NOT NULL DEFAULT 'unknown_schema',
    validation_error TEXT,
    validated_at TIMESTAMP WITH TIME ZONE,
    lexicon_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_record_did_collection
    ON public.record(did, collection);
  CREATE INDEX IF NOT EXISTS idx_record_collection_validation
    ON public.record(collection, validation_status);
  CREATE INDEX IF NOT EXISTS idx_record_timeline_collection_created
    ON public.record (collection, record_created_at DESC, uri DESC)
    WHERE record_created_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_record_timeline_author_collection_created
    ON public.record (did, collection, record_created_at DESC, uri DESC)
    WHERE record_created_at IS NOT NULL;
`

/** One row to insert into the fixture's `record` table. */
export interface SeedRecord {
  readonly did: string
  readonly collection: string
  readonly rkey: string
  /**
   * The record's `createdAt`: stored in the JSON and in Hyperindex's
   * materialized `record_created_at` column. Null stores a record whose
   * createdAt Hyperindex could not parse, so the column stays NULL.
   */
  readonly createdAt: string | null
  /** Extra top-level record JSON. */
  readonly json?: Record<string, unknown>
  /** Hyperindex validation status; defaults to `valid`. */
  readonly validation?: string
  /** Stored CID; defaults to a valid CID. Hyperindex stores '' when an event had none. */
  readonly cid?: string
}

export const uriOf = (record: {
  readonly did: string
  readonly collection: string
  readonly rkey: string
}): string => `at://${record.did}/${record.collection}/${record.rkey}`

/**
 * An isolated copy of the `record` table in its own schema, with a read-only
 * query pool pointed at it. Every test gets its own copy, so feed pages never
 * see rows seeded by another test.
 */
export class RecordFixture {
  /** Query executor over the fixture's read-only pool. */
  readonly database: SqlFeedQueryExecutor<ActivityFeedQueryRow> = {
    query: async (text, values = []) => {
      const result = await this.reader.query<ActivityFeedQueryRow>(text, [
        ...values,
      ])
      return { rows: result.rows }
    },
  }

  private constructor(
    private readonly admin: Pool,
    private readonly reader: Pool,
    private readonly schema: string,
  ) {}

  static async create(connectionString: string): Promise<RecordFixture> {
    const admin = new Pool({ connectionString, max: 2 })
    const schema = `feed_test_${randomBytes(6).toString('hex')}`
    await admin.query(RECORD_TABLE_DDL)
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.query(
      `CREATE TABLE ${schema}.record (LIKE public.record INCLUDING ALL)`,
    )
    const reader = new Pool({
      connectionString,
      max: 2,
      options: `-c search_path=${schema} -c default_transaction_read_only=on`,
    })
    return new RecordFixture(admin, reader, schema)
  }

  async seed(records: readonly SeedRecord[]): Promise<string[]> {
    const uris = records.map(uriOf)
    await this.admin.query(
      `INSERT INTO ${this.schema}.record
         (uri, cid, did, collection, json, record_created_at, validation_status)
       SELECT u.uri, u.cid, u.did, u.collection, u.json::jsonb, u.created_at, u.validation
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::text[])
         AS u(uri, cid, did, collection, json, created_at, validation)`,
      [
        uris,
        records.map((record) => record.cid ?? cid),
        records.map((record) => record.did),
        records.map((record) => record.collection),
        records.map((record) =>
          JSON.stringify({
            ...(record.createdAt === null
              ? {}
              : { createdAt: record.createdAt }),
            ...record.json,
          }),
        ),
        records.map((record) => record.createdAt),
        records.map((record) => record.validation ?? 'valid'),
      ],
    )
    return uris
  }

  /**
   * How the database orders URIs in the feed: rank 0 is the URI that sorts
   * first when ordering by `uri DESC`. The database collation decides, so
   * tests ask it instead of assuming plain string order.
   */
  async uriOrder(uris: readonly string[]): Promise<Map<string, number>> {
    const { rows } = await this.reader.query<{ uri: string }>(
      'SELECT u.uri FROM unnest($1::text[]) AS u(uri) ORDER BY u.uri DESC',
      [uris],
    )
    return new Map(rows.map((row, index) => [row.uri, index]))
  }

  async close(): Promise<void> {
    await this.reader.end()
    await this.admin.query(`DROP SCHEMA ${this.schema} CASCADE`)
    await this.admin.end()
  }
}
