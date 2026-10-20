import type { Logger } from 'pino'
import {
  Pool,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from 'pg'

import type { Config } from './config.js'

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
      application_name: 'hypercerts-feed-service',
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

  /** Verifies database reachability, Postgres 16 JSON/timestamp validation, and read-only session state. */
  async checkCompatibility(): Promise<DatabaseCompatibility> {
    try {
      const capabilities = await this.#pool.query<{
        server_version_num: number
        json_validation: boolean
        timestamp_validation: boolean
        transaction_read_only: string
      }>(`
        SELECT
          current_setting('server_version_num')::integer AS server_version_num,
          pg_input_is_valid('{"valid":true}', 'jsonb') AS json_validation,
          pg_input_is_valid('2026-01-01T00:00:00Z', 'timestamp with time zone') AS timestamp_validation,
          current_setting('transaction_read_only') AS transaction_read_only
      `)
      const capability = capabilities.rows[0]
      if (!capability || capability.server_version_num < 160000) {
        return {
          compatible: false,
          reason:
            'Postgres 16 or newer is required for safe parsing of HappyView JSON and timestamp text; upgrade the database before starting this service.',
        }
      }
      if (!capability.json_validation || !capability.timestamp_validation) {
        return {
          compatible: false,
          reason:
            'Postgres JSON or timestamp input validation is unavailable; verify pg_input_is_valid for jsonb and timestamp with time zone before starting this service.',
        }
      }
      if (capability.transaction_read_only !== 'on') {
        return {
          compatible: false,
          reason:
            'The feed database session is not read-only; keep default_transaction_read_only enabled and use a read-only database role.',
        }
      }

      return { compatible: true }
    } catch (cause) {
      this.#logger.warn({ err: cause }, 'database readiness check failed')
      if (
        typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        cause.code === '42883'
      ) {
        return {
          compatible: false,
          reason:
            'Postgres JSON or timestamp input validation is unavailable; verify pg_input_is_valid for jsonb and timestamp with time zone before starting this service.',
        }
      }
      return {
        compatible: false,
        reason:
          'Database readiness check failed; verify DATABASE_URL, network access, and database availability.',
      }
    }
  }

  /** Stops accepting database work and closes every idle pool connection. */
  async close(): Promise<void> {
    await this.#pool.end()
  }
}
