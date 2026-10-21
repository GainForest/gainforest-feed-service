import { lexParse, type BlobRef } from '@atproto/lex'
import { LexServerAuthError } from '@atproto/lex-server'
import { createServer } from '@atproto/lex-server/nodejs'
import type { AddressInfo } from 'node:net'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { createApp, type AppFeedServices } from '../src/app.js'
import type {
  ServiceAuthCredentials,
  OptionalServiceAuth,
} from '../src/auth/service-auth.js'
import type { DatabaseCompatibilityChecker } from '../src/database.js'
import { FeedError, FeedErrorCode } from '../src/feed/errors.js'
import type { FeedSkeletonReader } from '../src/feed/service.js'
import {
  HYPERCERTS_FEED_ID,
  HYPERCERTS_FEED_PARAMS_TYPE,
  type GetFeedSkeletonInput,
} from '../src/feed/types.js'
import type { HydratedFeedReader } from '../src/hydration/service.js'
import { Metrics } from '../src/metrics.js'

const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actor = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const uri = `at://${actor}/org.hypercerts.claim.activity/3kpn`
const blobCid = 'bafkreiehxpuhtr5f6v4eu4byjo2j7kkrhjvd7psmfu4imnpdzb3bdqb7vy'
const avatarBlob = lexParse<BlobRef>(
  JSON.stringify({
    $type: 'blob',
    ref: { $link: blobCid },
    mimeType: 'image/png',
    size: 128,
  }),
  { strict: true },
)
const logger = pino({ enabled: false })

const skeletonPath = 'http://localhost/xrpc/org.hypercerts.feed.getFeedSkeleton'
const hydratedPath = 'http://localhost/xrpc/org.hypercerts.feed.getFeed'

const compatibleDatabase: DatabaseCompatibilityChecker = {
  checkCompatibility: vi.fn(() => Promise.resolve({ compatible: true })),
}

const emptySkeleton = (): FeedSkeletonReader => ({
  getFeedSkeleton: vi.fn(() => Promise.resolve({ feed: [] })),
})

const emptyHydrated = (): HydratedFeedReader => ({
  getFeed: vi.fn(() => Promise.resolve({ feed: [] })),
})

const appServices = (
  skeleton: FeedSkeletonReader = emptySkeleton(),
  hydrated: HydratedFeedReader = emptyHydrated(),
): AppFeedServices => ({ skeleton, hydrated })

type JsonObject = Record<string, unknown>

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const expectErrorResponse = async (
  response: Response,
  expectedError: string,
  messageIncludes?: string,
): Promise<void> => {
  const value: unknown = await response.json()
  if (!isJsonObject(value)) throw new Error('Expected a JSON error object')
  expect(value.error).toBe(expectedError)
  if (messageIncludes === undefined) return
  if (typeof value.message !== 'string') {
    throw new Error('Expected the error response to include a message')
  }
  expect(value.message).toContain(messageIncludes)
}

const serverAddress = (
  server: ReturnType<typeof createServer>,
): AddressInfo => {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to have a TCP address')
  }
  return address
}

const feedRequest = (viewerDid = viewer): GetFeedSkeletonInput => ({
  feedId: HYPERCERTS_FEED_ID,
  params: { $type: HYPERCERTS_FEED_PARAMS_TYPE, viewerDid },
})

const post = (
  url: string,
  body: string,
  extraHeaders: HeadersInit = {},
): Request => {
  const headers = new Headers({ 'content-type': 'application/json' })
  new Headers(extraHeaders).forEach((value, key) => {
    headers.set(key, value)
  })
  return new Request(url, { method: 'POST', headers, body })
}

const trustedCredentials = (
  did: ServiceAuthCredentials['did'],
): ServiceAuthCredentials => ({
  did,
  didDocument: { id: did },
  jwt: {
    header: { alg: 'ES256' },
    payload: {
      iss: did,
      aud: 'did:web:feed.example',
      exp: 1,
      lxm: 'org.hypercerts.feed.getFeedSkeleton',
    },
    message: new Uint8Array(),
    signature: new Uint8Array(),
  },
})

const authFor =
  (
    credentials: ServiceAuthCredentials | undefined,
    invalidToken = false,
  ): OptionalServiceAuth =>
  ({ request }) => {
    if (invalidToken && request.headers.has('authorization')) {
      return Promise.reject(
        new LexServerAuthError(
          'AuthenticationRequired',
          'Invalid bearer token',
          { Bearer: { error: 'InvalidToken' } },
        ),
      )
    }
    return Promise.resolve(credentials)
  }

describe('HTTP application', () => {
  it('keeps authentication usable after a real HTTP POST body has been read', async () => {
    const auth: OptionalServiceAuth = ({ request }) => {
      request.signal.throwIfAborted()
      expect(request.headers.get('authorization')).toBe('Bearer test-token')
      return Promise.resolve(trustedCredentials(viewer))
    }
    const app = createApp(
      compatibleDatabase,
      appServices(),
      new Metrics(),
      logger,
      auth,
    )
    const server = createServer(app)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = serverAddress(server)
      for (const method of [
        'org.hypercerts.feed.getFeedSkeleton',
        'org.hypercerts.feed.getFeed',
      ]) {
        const response = await fetch(
          `http://127.0.0.1:${String(address.port)}/xrpc/${method}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer test-token',
            },
            body: JSON.stringify({
              feedId: HYPERCERTS_FEED_ID,
              params: { $type: HYPERCERTS_FEED_PARAMS_TYPE },
              limit: 1,
            }),
          },
        )
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ feed: [] })
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error)
          else resolve()
        })
      })
    }
  })

  it('describes the service at the root route', async () => {
    const metrics = new Metrics()
    const app = createApp(compatibleDatabase, appServices(), metrics, logger)

    const response = await app.fetch(new Request('http://localhost/'))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      name: 'Hypercerts Feed Service',
      description: 'Read-only Hypercerts feeds over XRPC.',
      endpoints: [
        '/xrpc/org.hypercerts.feed.getFeedSkeleton',
        '/xrpc/org.hypercerts.feed.getFeed',
      ],
    })
    const metricText = await metrics.registry.metrics()
    expect(metricText).toContain('route="root"')
  })

  it('publishes the configured did:web feed service at its canonical domain', async () => {
    const app = createApp(
      compatibleDatabase,
      appServices(),
      new Metrics(),
      logger,
      undefined,
      'did:web:dev.feed.hypercerts.dev',
    )

    const response = await app.fetch(
      new Request('https://dev.feed.hypercerts.dev/.well-known/did.json'),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:web:dev.feed.hypercerts.dev',
      service: [
        {
          id: '#hypercerts_feed',
          type: 'HypercertsFeedService',
          serviceEndpoint: 'https://dev.feed.hypercerts.dev',
        },
      ],
    })
  })

  it('uses the configured production DID rather than the request hostname', async () => {
    const app = createApp(
      compatibleDatabase,
      appServices(),
      new Metrics(),
      logger,
      undefined,
      'did:web:feed.hypercerts.dev',
    )

    const response = await app.fetch(
      new Request('https://other.example/.well-known/did.json'),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:web:feed.hypercerts.dev',
      service: [
        {
          id: '#hypercerts_feed',
          type: 'HypercertsFeedService',
          serviceEndpoint: 'https://feed.hypercerts.dev',
        },
      ],
    })
  })

  it('does not publish a did:web document for a non-web DID', async () => {
    const app = createApp(
      compatibleDatabase,
      appServices(),
      new Metrics(),
      logger,
      undefined,
      'did:plc:ar7c4by46qjdydhdevvrndac',
    )
    const response = await app.fetch(
      new Request('https://dev.feed.hypercerts.dev/.well-known/did.json'),
    )
    expect(response.status).toBe(404)
  })

  it('rejects non-GET requests to the DID document', async () => {
    const app = createApp(
      compatibleDatabase,
      appServices(),
      new Metrics(),
      logger,
      undefined,
      'did:web:dev.feed.hypercerts.dev',
    )
    const response = await app.fetch(
      post('https://dev.feed.hypercerts.dev/.well-known/did.json', '{}'),
    )
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
  })

  it('rejects non-GET requests to the root route', async () => {
    const app = createApp(
      compatibleDatabase,
      appServices(),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(
      new Request('http://localhost/', { method: 'POST' }),
    )

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
    await expect(response.json()).resolves.toEqual({
      error: 'InvalidRequest',
      message: 'This endpoint requires GET; change the HTTP method and retry.',
    })
  })

  it('serves the generic skeleton POST procedure', async () => {
    let received: GetFeedSkeletonInput | undefined
    const skeleton: FeedSkeletonReader = {
      getFeedSkeleton: vi.fn((input: GetFeedSkeletonInput) => {
        received = input
        return Promise.resolve({ feed: [{ subject: uri }] })
      }),
    }
    const app = createApp(
      compatibleDatabase,
      appServices(skeleton),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(
      post(skeletonPath, JSON.stringify(feedRequest())),
    )

    expect(response.status).toBe(200)
    expect(received).toMatchObject(feedRequest())
    await expect(response.json()).resolves.toEqual({
      feed: [{ subject: uri }],
    })
  })

  it.each([
    ['skeleton', skeletonPath],
    ['hydrated', hydratedPath],
  ] as const)(
    'binds authenticated omitted viewerDid to the %s service',
    async (_label, url) => {
      let received: GetFeedSkeletonInput | undefined
      const skeleton: FeedSkeletonReader = {
        getFeedSkeleton: vi.fn((input: GetFeedSkeletonInput) => {
          received = input
          return Promise.resolve({ feed: [] })
        }),
      }
      const hydrated: HydratedFeedReader = {
        getFeed: vi.fn((input: GetFeedSkeletonInput) => {
          received = input
          return Promise.resolve({ feed: [] })
        }),
      }
      const app = createApp(
        compatibleDatabase,
        appServices(skeleton, hydrated),
        new Metrics(),
        logger,
        authFor(trustedCredentials(viewer)),
      )

      const response = await app.fetch(
        post(
          url,
          JSON.stringify({
            feedId: HYPERCERTS_FEED_ID,
            params: { $type: HYPERCERTS_FEED_PARAMS_TYPE },
          }),
          { authorization: 'Bearer trusted-token' },
        ),
      )

      expect(response.status).toBe(200)
      expect(received).toMatchObject({
        feedId: HYPERCERTS_FEED_ID,
        params: { $type: HYPERCERTS_FEED_PARAMS_TYPE, viewerDid: viewer },
      })
    },
  )

  it.each([
    ['skeleton', skeletonPath],
    ['hydrated', hydratedPath],
  ] as const)(
    'rejects an authenticated supplied viewer mismatch on the %s route',
    async (_label, url) => {
      const getFeedSkeleton = vi.fn()
      const getFeed = vi.fn()
      const app = createApp(
        compatibleDatabase,
        appServices({ getFeedSkeleton }, { getFeed }),
        new Metrics(),
        logger,
        authFor(trustedCredentials(viewer)),
      )

      const response = await app.fetch(
        post(url, JSON.stringify(feedRequest(actor)), {
          authorization: 'Bearer trusted-token',
        }),
      )

      expect(response.status).toBe(400)
      expect(getFeedSkeleton).not.toHaveBeenCalled()
      expect(getFeed).not.toHaveBeenCalled()
      await expectErrorResponse(
        response,
        'InvalidRequest',
        'does not match the authenticated',
      )
    },
  )

  it.each([
    ['skeleton', skeletonPath],
    ['hydrated', hydratedPath],
  ] as const)(
    'requires viewerDid for anonymous requests on the %s route',
    async (_label, url) => {
      const getFeedSkeleton = vi.fn()
      const getFeed = vi.fn()
      const app = createApp(
        compatibleDatabase,
        appServices({ getFeedSkeleton }, { getFeed }),
        new Metrics(),
        logger,
        authFor(undefined),
      )

      const response = await app.fetch(
        post(
          url,
          JSON.stringify({
            feedId: HYPERCERTS_FEED_ID,
            params: { $type: HYPERCERTS_FEED_PARAMS_TYPE },
          }),
        ),
      )

      expect(response.status).toBe(400)
      expect(getFeedSkeleton).not.toHaveBeenCalled()
      expect(getFeed).not.toHaveBeenCalled()
      await expectErrorResponse(
        response,
        'InvalidRequest',
        'required for anonymous requests',
      )
    },
  )

  it.each([
    ['skeleton', skeletonPath],
    ['hydrated', hydratedPath],
  ] as const)(
    'does not fall back to anonymous on invalid auth for the %s route',
    async (_label, url) => {
      const getFeedSkeleton = vi.fn()
      const getFeed = vi.fn()
      const app = createApp(
        compatibleDatabase,
        appServices({ getFeedSkeleton }, { getFeed }),
        new Metrics(),
        logger,
        authFor(undefined, true),
      )
      const token = 'Bearer invalid-token'

      const response = await app.fetch(
        post(url, JSON.stringify(feedRequest()), { authorization: token }),
      )
      const body = await response.text()

      expect(response.status).toBe(401)
      expect(body).not.toContain(token)
      expect(body).not.toContain(viewer)
      expect(getFeedSkeleton).not.toHaveBeenCalled()
      expect(getFeed).not.toHaveBeenCalled()
    },
  )

  it('serves the unauthenticated hydrated POST procedure', async () => {
    let received: GetFeedSkeletonInput | undefined
    const hydrated: HydratedFeedReader = {
      getFeed: vi.fn((input: GetFeedSkeletonInput) => {
        received = input
        return Promise.resolve({
          feed: [
            {
              subject: uri,
              view: {
                $type: 'org.hypercerts.feed.defs#hypercertsFeedView' as const,
                kind: 'cert.create' as const,
                actor: {
                  did: actor,
                  avatar: {
                    $type: 'org.hypercerts.defs#smallImage' as const,
                    image: avatarBlob,
                  },
                },
                content: {
                  $type: 'org.hypercerts.feed.defs#activityView' as const,
                  title: 'Restore the watershed',
                  locationCount: 0,
                },
              },
            },
          ],
        })
      }),
    }
    const app = createApp(
      compatibleDatabase,
      appServices(emptySkeleton(), hydrated),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(
      post(hydratedPath, JSON.stringify(feedRequest())),
    )

    expect(response.status).toBe(200)
    expect(received).toMatchObject(feedRequest())
    await expect(response.json()).resolves.toMatchObject({
      feed: [
        {
          subject: uri,
          view: {
            $type: 'org.hypercerts.feed.defs#hypercertsFeedView',
            actor: {
              did: actor,
              avatar: {
                $type: 'org.hypercerts.defs#smallImage',
                image: {
                  $type: 'blob',
                  ref: { $link: blobCid },
                  mimeType: 'image/png',
                  size: 128,
                },
              },
            },
            content: {
              $type: 'org.hypercerts.feed.defs#activityView',
            },
          },
        },
      ],
    })
  })

  it('handles feed preflights from any browser origin', async () => {
    const metrics = new Metrics()
    const app = createApp(compatibleDatabase, appServices(), metrics, logger)

    for (const origin of [
      'https://certified.app',
      'https://untrusted.example',
      'http://localhost:4173',
    ]) {
      const response = await app.fetch(
        new Request(hydratedPath, {
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type, authorization',
          },
        }),
      )

      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('access-control-allow-methods')).toBe('POST')
      expect(response.headers.get('access-control-allow-headers')).toBe(
        'content-type, authorization',
      )
      expect(response.headers.has('vary')).toBe(false)
    }

    const metricText = await metrics.registry.metrics()
    expect(metricText).not.toContain(
      'hypercerts_feed_errors_total{error="InvalidRequest"}',
    )
  })

  it.each([
    ['missing requested method', {}, 'must request POST'],
    [
      'unsupported requested method',
      { 'access-control-request-method': 'GET' },
      'must request POST',
    ],
    [
      'unsupported requested header',
      {
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-request-id',
      },
      'unsupported header',
    ],
  ])('rejects %s feed preflight', async (_label, headers, message) => {
    const metrics = new Metrics()
    const app = createApp(compatibleDatabase, appServices(), metrics, logger)

    const response = await app.fetch(
      new Request(hydratedPath, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://certified.app',
          ...(headers as Record<string, string>),
        },
      }),
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    await expectErrorResponse(response, 'InvalidRequest', message)
    const metricText = await metrics.registry.metrics()
    expect(metricText).toContain(
      'hypercerts_feed_errors_total{error="InvalidRequest"} 1',
    )
  })

  it('does not count operational endpoint errors as feed errors', async () => {
    const metrics = new Metrics()
    const app = createApp(compatibleDatabase, appServices(), metrics, logger)

    await app.fetch(new Request('http://localhost/health', { method: 'POST' }))
    await app.fetch(new Request('http://localhost/ready', { method: 'POST' }))

    const metricText = await metrics.registry.metrics()
    expect(metricText).not.toContain(
      'hypercerts_feed_errors_total{error="InvalidRequest"}',
    )
  })

  it('leaves operational endpoints without CORS headers', async () => {
    const app = createApp(
      compatibleDatabase,
      appServices(),
      new Metrics(),
      logger,
    )

    for (const path of ['/health', '/ready']) {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, {
          headers: { origin: 'https://certified.app' },
        }),
      )

      expect(response.headers.has('access-control-allow-origin')).toBe(false)
    }
  })

  it('does not expose the metrics registry over HTTP', async () => {
    const app = createApp(
      compatibleDatabase,
      appServices(),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(new Request('http://localhost/metrics'))

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).not.toContain(
      'text/plain; version=',
    )
  })

  it('adds wildcard CORS headers to a feed response', async () => {
    const app = createApp(
      compatibleDatabase,
      appServices(),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(
      new Request(skeletonPath, {
        method: 'POST',
        headers: {
          origin: 'https://certified.app',
          'content-type': 'application/json',
        },
        body: JSON.stringify(feedRequest()),
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.has('vary')).toBe(false)
  })

  it.each([
    ['skeleton', skeletonPath],
    ['hydrated', hydratedPath],
  ])(
    'rejects malformed JSON for the %s route without invoking services',
    async (_label, url) => {
      const getFeedSkeleton = vi.fn()
      const getFeed = vi.fn()
      const app = createApp(
        compatibleDatabase,
        appServices({ getFeedSkeleton }, { getFeed }),
        new Metrics(),
        logger,
      )

      const response = await app.fetch(
        new Request(url, {
          method: 'POST',
          headers: {
            origin: 'https://certified.app',
            'content-type': 'application/json',
          },
          body: '{',
        }),
      )

      expect(response.status).toBe(400)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(getFeedSkeleton).not.toHaveBeenCalled()
      expect(getFeed).not.toHaveBeenCalled()
      await expectErrorResponse(response, 'InvalidRequest', 'not valid JSON')
    },
  )

  it.each([
    ['skeleton', skeletonPath],
    ['hydrated', hydratedPath],
  ])(
    'rejects an oversized declared body for the %s route',
    async (_label, url) => {
      const getFeedSkeleton = vi.fn()
      const getFeed = vi.fn()
      const app = createApp(
        compatibleDatabase,
        appServices({ getFeedSkeleton }, { getFeed }),
        new Metrics(),
        logger,
      )

      const response = await app.fetch(
        new Request(url, {
          method: 'POST',
          headers: {
            origin: 'https://certified.app',
            'content-length': String(64 * 1024 + 1),
            'content-type': 'application/json',
          },
          body: '{}',
        }),
      )

      expect(response.status).toBe(413)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(getFeedSkeleton).not.toHaveBeenCalled()
      expect(getFeed).not.toHaveBeenCalled()
      await expect(response.json()).resolves.toEqual({
        error: 'InvalidRequest',
        message:
          'Request body exceeds the 65536-byte limit; remove unnecessary feed parameters or other fields before retrying.',
      })
    },
  )

  it('cancels and rejects an oversized streamed feed body', async () => {
    const getFeedSkeleton = vi.fn()
    const getFeed = vi.fn()
    const metrics = new Metrics()
    const app = createApp(
      compatibleDatabase,
      appServices({ getFeedSkeleton }, { getFeed }),
      metrics,
      logger,
    )
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1))
      },
      cancel,
    })

    const response = await app.fetch(
      new Request(hydratedPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    )

    expect(response.status).toBe(413)
    expect(cancel).toHaveBeenCalledWith('request body limit exceeded')
    expect(getFeedSkeleton).not.toHaveBeenCalled()
    expect(getFeed).not.toHaveBeenCalled()
  })

  it.each([
    ['skeleton', skeletonPath],
    ['hydrated', hydratedPath],
  ])('rejects non-POST requests for the %s procedure', async (_label, url) => {
    const getFeedSkeleton = vi.fn()
    const getFeed = vi.fn()
    const app = createApp(
      compatibleDatabase,
      appServices({ getFeedSkeleton }, { getFeed }),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(new Request(url))

    expect(response.status).toBe(405)
    expect(getFeedSkeleton).not.toHaveBeenCalled()
    expect(getFeed).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: 'InvalidRequest',
    })
  })

  it.each([
    [
      'skeleton',
      skeletonPath,
      appServices({
        getFeedSkeleton: vi.fn(() =>
          Promise.resolve({ feed: [{ subject: 'not-an-at-uri' }] }),
        ),
      }),
    ],
    [
      'hydrated',
      hydratedPath,
      appServices(emptySkeleton(), {
        getFeed: vi.fn(() =>
          Promise.resolve({
            feed: [
              {
                subject: 'not-an-at-uri',
                view: {
                  $type: 'org.hypercerts.feed.defs#hypercertsFeedView' as const,
                  kind: 'cert.create' as const,
                  actor: { did: 'not-a-did' },
                  content: {
                    $type: 'org.hypercerts.feed.defs#activityView' as const,
                    title: 'Invalid response fixture',
                    locationCount: 0,
                  },
                },
              },
            ],
          }),
        ),
      }),
    ],
  ])(
    'rejects an invalid %s service response instead of violating the Lexicon',
    async (_label, url, services) => {
      const app = createApp(compatibleDatabase, services, new Metrics(), logger)

      const response = await app.fetch(post(url, JSON.stringify(feedRequest())))

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toMatchObject({
        error: 'InternalError',
      })
    },
  )

  it.each([
    ['org.hypercerts.feed.getFeedSkeleton', skeletonPath],
    ['org.hypercerts.feed.getFeed', hydratedPath],
  ])('normalizes Lexicon validation failures for %s', async (nsid, url) => {
    const app = createApp(
      compatibleDatabase,
      appServices(),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(post(url, '{}'))

    expect(response.status).toBe(400)
    await expectErrorResponse(response, 'InvalidRequest', nsid)
  })

  it.each([
    ['skeleton', skeletonPath],
    ['hydrated', hydratedPath],
  ])(
    'rejects a malformed viewer for the %s route as InvalidRequest',
    async (_label, url) => {
      const getFeedSkeleton = vi.fn()
      const getFeed = vi.fn()
      const app = createApp(
        compatibleDatabase,
        appServices({ getFeedSkeleton }, { getFeed }),
        new Metrics(),
        logger,
      )

      const response = await app.fetch(
        post(url, JSON.stringify(feedRequest('alice.test'))),
      )

      expect(response.status).toBe(400)
      expect(getFeedSkeleton).not.toHaveBeenCalled()
      expect(getFeed).not.toHaveBeenCalled()
      await expectErrorResponse(response, 'InvalidRequest', 'Invalid DID')
    },
  )

  it.each([
    [
      'skeleton',
      skeletonPath,
      appServices({
        getFeedSkeleton: vi.fn(() =>
          Promise.reject(
            new FeedError(
              FeedErrorCode.UnsupportedFeed,
              'The requested feed is not supported.',
            ),
          ),
        ),
      }),
    ],
    [
      'hydrated',
      hydratedPath,
      appServices(emptySkeleton(), {
        getFeed: vi.fn(() =>
          Promise.reject(
            new FeedError(
              FeedErrorCode.UnsupportedFeed,
              'The requested feed is not supported.',
            ),
          ),
        ),
      }),
    ],
  ])(
    'exposes UnsupportedFeed from the %s route',
    async (_label, url, services) => {
      const app = createApp(compatibleDatabase, services, new Metrics(), logger)
      const response = await app.fetch(
        post(
          url,
          JSON.stringify({
            feedId: 'app.example.feed.defs#futureFeed',
            params: { $type: 'app.example.feed.defs#futureParams' },
          }),
        ),
      )

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: 'UnsupportedFeed',
        message: 'The requested feed is not supported.',
      })
    },
  )

  it('counts a route-generated InvalidRequest only once', async () => {
    const metrics = new Metrics()
    const getFeedSkeleton = vi.fn(() =>
      Promise.reject(
        new FeedError(FeedErrorCode.InvalidRequest, 'The request is invalid.'),
      ),
    )
    const app = createApp(
      compatibleDatabase,
      appServices({ getFeedSkeleton }),
      metrics,
      logger,
    )

    const response = await app.fetch(
      post(skeletonPath, JSON.stringify(feedRequest())),
    )

    expect(response.status).toBe(400)
    const metricText = await metrics.registry.metrics()
    expect(metricText).toContain(
      'hypercerts_feed_errors_total{error="InvalidRequest"} 1',
    )
  })

  it('translates expected skeleton InvalidRequest details', async () => {
    const getFeedSkeleton = vi.fn(() =>
      Promise.reject(
        new FeedError(
          FeedErrorCode.InvalidRequest,
          'Reduce trustedEvaluators before retrying.',
          422,
        ),
      ),
    )
    const app = createApp(
      compatibleDatabase,
      appServices({ getFeedSkeleton }),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(
      post(skeletonPath, JSON.stringify(feedRequest())),
    )

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({
      error: 'InvalidRequest',
      message: 'Reduce trustedEvaluators before retrying.',
    })
  })

  it('translates expected hydrated FeedError details without leaking its cause', async () => {
    const internalCause = new Error('secret database detail')
    const getFeed = vi.fn(() =>
      Promise.reject(
        new FeedError(
          FeedErrorCode.InvalidRequest,
          'Reduce trustedEvaluators before retrying.',
          422,
          { cause: internalCause },
        ),
      ),
    )
    const app = createApp(
      compatibleDatabase,
      appServices(emptySkeleton(), { getFeed }),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(
      post(hydratedPath, JSON.stringify(feedRequest())),
    )
    const responseText = await response.text()

    expect(getFeed).toHaveBeenCalledOnce()
    expect(response.status).toBe(422)
    expect(JSON.parse(responseText)).toEqual({
      error: 'InvalidRequest',
      message: 'Reduce trustedEvaluators before retrying.',
    })
    expect(responseText).not.toContain(internalCause.message)
  })

  it('redacts unknown hydrated failures and records bounded route/error metrics', async () => {
    const getFeed = vi.fn(() =>
      Promise.reject(new Error('secret hydrated failure')),
    )
    const metrics = new Metrics()
    const app = createApp(
      compatibleDatabase,
      appServices(emptySkeleton(), { getFeed }),
      metrics,
      logger,
    )

    const response = await app.fetch(
      post(hydratedPath, JSON.stringify(feedRequest())),
    )
    const responseText = await response.text()
    const metricText = await metrics.registry.metrics()

    expect(response.status).toBe(500)
    expect(responseText).not.toContain('secret hydrated failure')
    expect(JSON.parse(responseText)).toMatchObject({ error: 'InternalError' })
    expect(metricText).toContain('route="feed_hydrated"')
    expect(metricText).toContain('error="InternalError"')
    expect(metricText).not.toContain(viewer)
    expect(metricText).not.toContain(uri)
  })

  it('maps arbitrary HTTP methods to the bounded OTHER metrics label', async () => {
    const metrics = new Metrics()
    const app = createApp(compatibleDatabase, appServices(), metrics, logger)

    await app.fetch(
      new Request('http://localhost/not-found', { method: 'BREW' }),
    )
    await app.fetch(
      new Request('http://localhost/not-found', { method: 'REINDEX' }),
    )
    const metricText = await metrics.registry.metrics()

    expect(metricText).toContain('method="OTHER"')
    expect(metricText).not.toContain('method="BREW"')
    expect(metricText).not.toContain('method="REINDEX"')
  })

  it('reports readiness failures without marking the process unhealthy', async () => {
    const database: DatabaseCompatibilityChecker = {
      checkCompatibility: vi.fn(() =>
        Promise.resolve({
          compatible: false,
          reason: 'database readiness capability check failed',
        }),
      ),
    }
    const app = createApp(database, appServices(), new Metrics(), logger)

    const health = await app.fetch(new Request('http://localhost/health'))
    const ready = await app.fetch(new Request('http://localhost/ready'))

    expect(health.status).toBe(200)
    expect(ready.status).toBe(503)
    await expect(ready.json()).resolves.toMatchObject({ status: 'not_ready' })
  })
})
