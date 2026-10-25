import type { Logger } from 'pino'
import {
  Pool,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from 'pg'

import type { Config } from './config.js'
import { sqlState } from './sql-state.js'

/** Result of checking whether the connected database has the capabilities required by the feed. */
export interface DatabaseCompatibility {
  /** Whether the database is reachable, supports the required Postgres capabilities, and is read-only. */
  readonly compatible: boolean
  /** Actionable reason readiness failed; absent when compatible is true. */
  readonly reason?: string
}

/** Minimal database capability consumed by the readiness endpoint. */
export interface DatabaseCompatibilityChecker {
  /** Checks database reachability, required Postgres capabilities, and read-only session state. */
  checkCompatibility(): Promise<DatabaseCompatibility>
}

/** Small read-only Postgres pool used by the feed query and readiness checks. */
export class Database implements DatabaseCompatibilityChecker {
  readonly #pool: Pool
  readonly #logger: Logger

  /** Creates a pool that enforces read-only sessions in addition to database-role grants. */
  constructor(config: Config, logger: Logger) {
    this.#logger = logger
    const poolConfig: PoolConfig = {
      connectionString: config.databaseUrl,
      max: config.databaseMaxConnections,
      min: 1,
      idleTimeoutMillis: config.databaseIdleTimeoutMs,
      connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
      statement_timeout: config.databaseStatementTimeoutMs,
      application_name: 'gainforest-feed-service',
      options: '-c default_transaction_read_only=on',
    }
    this.#pool = new Pool(poolConfig)
    this.#pool.on('error', (error) => {
      logger.error({ err: error }, 'idle Postgres client failed')
    })
  }

  /** Executes one parameterized read query through the bounded pool. */
  query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.#pool.query<T>(text, [...values])
  }

  /** Verifies database reachability, Postgres 16 JSON validation, the Hyperindex record columns the feed reads, and read-only session state. */
  async checkCompatibility(): Promise<DatabaseCompatibility> {
    try {
      const capabilities = await this.#pool.query<{
        server_version_num: number
        json_validation: boolean
        transaction_read_only: string
      }>(`
        SELECT
          current_setting('server_version_num')::integer AS server_version_num,
          pg_input_is_valid('{"valid":true}', 'jsonb') AS json_validation,
          current_setting('transaction_read_only') AS transaction_read_only
      `)
      const capability = capabilities.rows[0]
      if (!capability || capability.server_version_num < 160000) {
        return {
          compatible: false,
          reason:
            'Postgres 16 or newer is required for safe parsing of JSON stored as text inside Hyperindex records; upgrade the database before starting this service.',
        }
      }
      if (!capability.json_validation) {
        return {
          compatible: false,
          reason:
            'Postgres JSON input validation is unavailable; verify pg_input_is_valid for jsonb before starting this service.',
        }
      }
      if (capability.transaction_read_only !== 'on') {
        return {
          compatible: false,
          reason:
            'The feed database session is not read-only; keep default_transaction_read_only enabled and use a read-only database role.',
        }
      }
      const schemaProblem = await this.#checkRecordTable()
      if (schemaProblem !== undefined) {
        return { compatible: false, reason: schemaProblem }
      }

      return { compatible: true }
    } catch (cause) {
      this.#logger.warn({ err: cause }, 'database readiness check failed')
      if (sqlState(cause) === '42883') {
        return {
          compatible: false,
          reason:
            'Postgres JSON input validation is unavailable; verify pg_input_is_valid for jsonb before starting this service.',
        }
      }
      return {
        compatible: false,
        reason:
          'Database readiness check failed; verify DATABASE_URL, network access, and database availability.',
      }
    }
  }

  /**
   * Confirms that the feed's role can read the Hyperindex columns the feed
   * statement uses. Returns an actionable reason when it cannot.
   */
  async #checkRecordTable(): Promise<string | undefined> {
    try {
      await this.#pool.query(
        'SELECT uri, cid, did, collection, json, record_created_at, validation_status FROM record WHERE false',
      )
      return undefined
    } catch (cause) {
      this.#logger.warn({ err: cause }, 'Hyperindex record table check failed')
      const state = sqlState(cause)
      if (state === '42P01') {
        return 'The Hyperindex record table was not found; point DATABASE_URL at the Hyperindex database and make sure its migrations have run (the service needs migrations 010 and 012).'
      }
      if (state === '42703') {
        return 'The Hyperindex record table lacks record_created_at or validation_status; run Hyperindex migrations 010 and 012 before starting this service.'
      }
      if (state === '42501') {
        return 'The feed database role cannot read the Hyperindex record table; grant SELECT on it to the role.'
      }
      throw cause
    }
  }

  /** Stops accepting database work and closes every idle pool connection. */
  async close(): Promise<void> {
    await this.#pool.end()
  }
}
