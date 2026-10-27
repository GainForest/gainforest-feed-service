import { createServer } from '@atproto/lex-server/nodejs'
import pino from 'pino'

import { createApp } from './app.js'
import { createConfiguredServiceAuth } from './auth/service-auth.js'
import { loadConfig } from './config.js'
import { Database } from './database.js'
import { createFollowingFeed } from './feed/following.js'
import { createActivityFeed } from './feed/query.js'
import { FeedRegistry } from './feed/registry.js'
import { FeedService } from './feed/service.js'
import { loadLocalEnvironment } from './environment.js'
import {
  closeMetricsServer,
  createMetricsServer,
  listenMetricsServer,
} from './metrics-server.js'
import { Metrics } from './metrics.js'

loadLocalEnvironment()
const config = loadConfig()
const logger = pino({ level: config.logLevel })
const metrics = new Metrics()
const database = new Database(config, logger)
const activityFeed = createActivityFeed({ database, metrics })
const followingFeed = createFollowingFeed({ database, metrics })
const feeds = new FeedRegistry([activityFeed, followingFeed])
const feedService = new FeedService(feeds)
const auth = createConfiguredServiceAuth(config)
const app = createApp(
  database,
  { skeleton: feedService, feed: feedService },
  metrics,
  logger,
  auth,
  config.serviceDid,
)

metrics.setReady(false)

const server = createServer(app, {
  gracefulTerminationTimeout: config.gracefulShutdownMs,
})
const metricsServer =
  config.metricsPort === undefined
    ? undefined
    : createMetricsServer(metrics, {
        requestTimeoutMs: config.requestTimeoutMs,
        onError: (error) => {
          logger.error({ err: error }, 'metrics server error')
        },
      })
// Node's request timeout bounds receiving the request, not handler or database work.
server.requestTimeout = config.requestTimeoutMs
server.headersTimeout = config.requestTimeoutMs + 1_000
server.keepAliveTimeout = 5_000

try {
  if (metricsServer && config.metricsPort !== undefined) {
    await listenMetricsServer(
      metricsServer,
      config.metricsPort,
      config.metricsHost,
    )
    logger.info(
      { host: config.metricsHost, port: config.metricsPort },
      'Metrics server is listening',
    )
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      resolve()
    })
  })
} catch (cause) {
  if (metricsServer?.listening === true) {
    try {
      await closeMetricsServer(metricsServer, config.gracefulShutdownMs)
    } catch (error) {
      logger.error({ err: error }, 'metrics server startup cleanup failed')
    }
  }
  try {
    await database.close()
  } catch (error) {
    logger.error({ err: error }, 'database startup cleanup failed')
  }
  throw cause
}
logger.info(
  { host: config.host, port: config.port },
  'GainForest feed service is listening',
)

try {
  const compatibility = await database.checkCompatibility()
  metrics.setReady(compatibility.compatible)
  if (!compatibility.compatible) {
    logger.warn(
      { reason: compatibility.reason },
      'database compatibility check failed; service is listening but not ready',
    )
  }
} catch (error) {
  metrics.setReady(false)
  logger.error(
    { err: error },
    'initial database compatibility check failed; service is listening but not ready',
  )
}

let shutdownPromise: Promise<void> | undefined
const shutdown = (signal: NodeJS.Signals): Promise<void> => {
  shutdownPromise ??= (async () => {
    logger.info({ signal }, 'graceful shutdown started')
    let failed = false
    try {
      await server.terminate()
    } catch (error) {
      failed = true
      logger.error({ err: error }, 'HTTP server termination failed')
    }
    if (metricsServer) {
      try {
        await closeMetricsServer(metricsServer, config.gracefulShutdownMs)
      } catch (error) {
        failed = true
        logger.error({ err: error }, 'metrics server shutdown failed')
      }
    }
    try {
      await database.close()
    } catch (error) {
      failed = true
      logger.error({ err: error }, 'database pool shutdown failed')
    }
    if (failed) {
      process.exitCode = 1
      return
    }
    logger.info('graceful shutdown completed')
  })()
  return shutdownPromise
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
