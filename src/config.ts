import { isValidDid, type DidString } from '@atproto/syntax'

/** Runtime settings for the standalone feed service and its read-only database pool. */
export interface Config {
  /** TCP interface used by the HTTP server. */
  readonly host: string
  /** TCP port used by the HTTP server. */
  readonly port: number
  /** TCP interface used by the optional metrics server. */
  readonly metricsHost: string
  /** TCP port used by the optional metrics server, or undefined when disabled. */
  readonly metricsPort: number | undefined
  /** Postgres connection URL for Hyperindex's existing database. */
  readonly databaseUrl: string
  /** Maximum number of Postgres sessions held by this sidecar. */
  readonly databaseMaxConnections: number
  /** Time an excess Postgres session may remain idle before the pool closes it. */
  readonly databaseIdleTimeoutMs: number
  /** Maximum time to wait for a database connection. */
  readonly databaseConnectionTimeoutMs: number
  /** Per-statement Postgres timeout. */
  readonly databaseStatementTimeoutMs: number
  /** Maximum time allowed to receive a complete HTTP request. */
  readonly requestTimeoutMs: number
  /** Maximum time graceful shutdown waits for active requests. */
  readonly gracefulShutdownMs: number
  /** DID of this service; required as the service-auth JWT audience. */
  readonly serviceDid: DidString
  /** Maximum accepted age of a service-auth JWT, in seconds. */
  readonly serviceAuthMaxAgeSeconds: number
  /** Maximum time allowed for one DID document resolution. */
  readonly didResolutionTimeoutMs: number
  /** Pino logging threshold. */
  readonly logLevel: string
}

const parseIntegerEnv = (
  raw: string,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer from ${String(minimum)} through ${String(maximum)}; change ${name} from ${JSON.stringify(raw)} to a value in that range.`,
    )
  }
  return parsed
}

const integerEnv = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = env[name]
  return raw === undefined || raw === ''
    ? fallback
    : parseIntegerEnv(raw, name, minimum, maximum)
}

const optionalIntegerEnv = (
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined => {
  const raw = env[name]
  return raw === undefined || raw === ''
    ? undefined
    : parseIntegerEnv(raw, name, minimum, maximum)
}

/** Loads and validates process environment values before any listener or pool is started. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const databaseUrl = env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'DATABASE_URL is required; set it to the dedicated read-only Postgres connection URL for the Hyperindex database.',
    )
  }
  let parsedDatabaseUrl: URL
  try {
    parsedDatabaseUrl = new URL(databaseUrl)
  } catch (cause) {
    throw new Error(
      'DATABASE_URL is not a valid URL; set a postgres:// or postgresql:// connection URL.',
      { cause },
    )
  }
  if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)) {
    throw new Error(
      `DATABASE_URL uses ${parsedDatabaseUrl.protocol}; use a postgres:// or postgresql:// connection URL.`,
    )
  }

  const serviceDid = env.SERVICE_DID
  if (serviceDid === undefined || serviceDid === '') {
    throw new Error(
      'SERVICE_DID is required; set it to the valid DID identifying this service for service-auth JWT audience verification.',
    )
  }
  if (!isValidDid(serviceDid)) {
    throw new Error(
      `SERVICE_DID ${JSON.stringify(serviceDid)} is not a valid DID; set it to the DID identifying this service.`,
    )
  }

  const port = integerEnv(env, 'PORT', 3000, 1, 65_535)
  const metricsPort = optionalIntegerEnv(env, 'METRICS_PORT', 1, 65_535)
  if (metricsPort === port) {
    throw new Error(
      'METRICS_PORT must differ from PORT; set the public and private listeners to separate ports.',
    )
  }

  return {
    host: env.HOST === undefined || env.HOST === '' ? '0.0.0.0' : env.HOST,
    port,
    serviceDid,
    serviceAuthMaxAgeSeconds: integerEnv(
      env,
      'SERVICE_AUTH_MAX_AGE_SECONDS',
      300,
      1,
      3_600,
    ),
    didResolutionTimeoutMs: integerEnv(
      env,
      'DID_RESOLUTION_TIMEOUT_MS',
      2_000,
      100,
      60_000,
    ),
    metricsHost:
      env.METRICS_HOST === undefined || env.METRICS_HOST === ''
        ? '0.0.0.0'
        : env.METRICS_HOST,
    metricsPort,
    databaseUrl,
    databaseMaxConnections: integerEnv(
      env,
      'DATABASE_MAX_CONNECTIONS',
      5,
      1,
      20,
    ),
    databaseIdleTimeoutMs: integerEnv(
      env,
      'DATABASE_IDLE_TIMEOUT_MS',
      60_000,
      1_000,
      3_600_000,
    ),
    databaseConnectionTimeoutMs: integerEnv(
      env,
      'DATABASE_CONNECTION_TIMEOUT_MS',
      2_000,
      100,
      60_000,
    ),
    databaseStatementTimeoutMs: integerEnv(
      env,
      'DATABASE_STATEMENT_TIMEOUT_MS',
      5_000,
      100,
      60_000,
    ),
    requestTimeoutMs: integerEnv(
      env,
      'REQUEST_TIMEOUT_MS',
      10_000,
      100,
      120_000,
    ),
    gracefulShutdownMs: integerEnv(
      env,
      'GRACEFUL_SHUTDOWN_MS',
      10_000,
      100,
      120_000,
    ),
    logLevel:
      env.LOG_LEVEL === undefined || env.LOG_LEVEL === ''
        ? 'info'
        : env.LOG_LEVEL,
  }
}
