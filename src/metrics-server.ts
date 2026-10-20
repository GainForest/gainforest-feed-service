import { createServer, type Server, type ServerResponse } from 'node:http'

import type { Metrics } from './metrics.js'

const textResponse = (
  response: ServerResponse,
  status: number,
  body: string,
): void => {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Starts the metrics listener and rejects if its configured address cannot be bound. */
export const listenMetricsServer = (
  server: Server,
  port: number,
  host: string,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })

/** Stops accepting metrics requests and force-closes active connections at the deadline. */
export const closeMetricsServer = (
  server: Server,
  timeoutMs: number,
): Promise<void> => {
  if (!server.listening) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => {
      server.closeAllConnections()
      finish()
    }, timeoutMs)
    server.close((error) => finish(error ?? undefined))
  })
}

export interface MetricsServerOptions {
  readonly requestTimeoutMs: number
  readonly onError: (error: Error) => void
}

/** Builds the private HTTP listener that exposes this process's Prometheus-compatible metrics registry. */
export const createMetricsServer = (
  metrics: Metrics,
  options: MetricsServerOptions,
): Server => {
  const server = createServer((request, response) => {
    let pathname: string
    try {
      pathname = new URL(request.url ?? '/', 'http://metrics.internal').pathname
    } catch {
      textResponse(response, 400, 'Bad Request\n')
      return
    }
    if (pathname !== '/metrics') {
      textResponse(response, 404, 'Not Found\n')
      return
    }
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET')
      textResponse(response, 405, 'Method Not Allowed\n')
      return
    }

    void metrics.registry.metrics().then(
      (body) => {
        response.writeHead(200, {
          'content-type': metrics.registry.contentType,
          'content-length': Buffer.byteLength(body),
        })
        response.end(body)
      },
      () => textResponse(response, 500, 'Metrics collection failed\n'),
    )
  })
  server.requestTimeout = options.requestTimeoutMs
  server.headersTimeout = options.requestTimeoutMs + 1_000
  server.keepAliveTimeout = 5_000
  server.on('error', options.onError)
  return server
}
