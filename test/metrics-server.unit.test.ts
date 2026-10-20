import { connect, type AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Metrics } from '../src/metrics.js'
import {
  closeMetricsServer,
  createMetricsServer,
  listenMetricsServer,
} from '../src/metrics-server.js'

const servers: ReturnType<typeof createMetricsServer>[] = []

const createTestMetricsServer = (metrics = new Metrics()) =>
  createMetricsServer(metrics, {
    requestTimeoutMs: 1_000,
    onError: () => undefined,
  })

const listenerAddress = (
  server: ReturnType<typeof createMetricsServer>,
): AddressInfo => {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to have a TCP address')
  }
  return address
}

const listen = async (
  server: ReturnType<typeof createMetricsServer>,
): Promise<string> => {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = listenerAddress(server)
  return `http://127.0.0.1:${String(address.port)}`
}

const sendRawRequest = async (
  server: ReturnType<typeof createMetricsServer>,
  target: string,
): Promise<string> => {
  const address = listenerAddress(server)
  return new Promise<string>((resolve, reject) => {
    let response = ''
    const socket = connect(address.port, '127.0.0.1', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      )
    })
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8')
    })
    socket.on('end', () => {
      resolve(response)
    })
    socket.on('error', reject)
  })
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      if (!server.listening) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error)
          else resolve()
        })
      })
    }),
  )
})

describe('createMetricsServer', () => {
  it('applies bounded HTTP timeouts and reports listener errors', () => {
    const onError = vi.fn()
    const server = createMetricsServer(new Metrics(), {
      requestTimeoutMs: 250,
      onError,
    })
    const error = new Error('listener failed')

    expect(server.requestTimeout).toBe(250)
    expect(server.headersTimeout).toBe(1_250)
    expect(server.keepAliveTimeout).toBe(5_000)
    expect(() => server.emit('error', error)).not.toThrow()
    expect(onError).toHaveBeenCalledWith(error)
  })

  it('reports a startup error when its address is already in use', async () => {
    const first = createTestMetricsServer()
    await listen(first)
    const address = listenerAddress(first)
    const second = createTestMetricsServer()
    servers.push(second)

    await expect(
      listenMetricsServer(second, address.port, '127.0.0.1'),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('force-closes active responses after the shutdown deadline', async () => {
    const metrics = new Metrics()
    let collectionStarted!: () => void
    const started = new Promise<void>((resolve) => {
      collectionStarted = resolve
    })
    vi.spyOn(metrics.registry, 'metrics').mockImplementation(() => {
      collectionStarted()
      return new Promise<string>(() => undefined)
    })
    const server = createTestMetricsServer(metrics)
    const baseUrl = await listen(server)
    const request = fetch(`${baseUrl}/metrics`).catch(() => undefined)
    await started

    await closeMetricsServer(server, 20)

    await request
    expect(server.listening).toBe(false)
  })

  it('serves the isolated Prometheus registry from GET /metrics', async () => {
    const metrics = new Metrics()
    metrics.setReady(true)
    const baseUrl = await listen(createTestMetricsServer(metrics))

    const response = await fetch(`${baseUrl}/metrics`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'text/plain; version=0.0.4; charset=utf-8',
    )
    await expect(response.text()).resolves.toContain('hypercerts_feed_ready 1')
  })

  it('returns an internal error when metrics collection fails', async () => {
    const metrics = new Metrics()
    vi.spyOn(metrics.registry, 'metrics').mockRejectedValue(
      new Error('collection failed'),
    )
    const baseUrl = await listen(createTestMetricsServer(metrics))

    const response = await fetch(`${baseUrl}/metrics`)

    expect(response.status).toBe(500)
    await expect(response.text()).resolves.toBe('Metrics collection failed\n')
  })

  it('returns a bad-request response for malformed request targets', async () => {
    const server = createTestMetricsServer()
    await listen(server)

    const response = await sendRawRequest(server, 'http://[')

    expect(response).toContain('HTTP/1.1 400 Bad Request')
  })

  it('rejects non-GET metrics requests', async () => {
    const baseUrl = await listen(createTestMetricsServer())

    const response = await fetch(`${baseUrl}/metrics`, { method: 'POST' })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
  })

  it('does not serve other internal paths', async () => {
    const baseUrl = await listen(createTestMetricsServer())

    const response = await fetch(`${baseUrl}/ready`)

    expect(response.status).toBe(404)
  })
})
