import { performance } from 'node:perf_hooks'

import { LexRouter, LexServerError } from '@atproto/lex-server'
import type { Logger } from 'pino'

import { registerGetFeedSkeleton } from './api/get-feed-skeleton.js'
import { registerGetFeed } from './api/get-feed.js'
import type { OptionalServiceAuth } from './auth/service-auth.js'
import type { DatabaseCompatibilityChecker } from './database.js'
import { FeedErrorCode } from './feed/errors.js'
import type { FeedSkeletonReader } from './feed/service.js'
import type { HydratedFeedReader } from './hydration/service.js'
import type { Metrics } from './metrics.js'

const MAX_REQUEST_BODY_BYTES = 64 * 1024

const FEED_ROUTES = [
  {
    path: '/xrpc/org.hypercerts.feed.getFeedSkeleton',
    nsid: 'org.hypercerts.feed.getFeedSkeleton',
    label: 'feed_skeleton',
  },
  {
    path: '/xrpc/org.hypercerts.feed.getFeed',
    nsid: 'org.hypercerts.feed.getFeed',
    label: 'feed_hydrated',
  },
] as const

type FeedRoute = (typeof FEED_ROUTES)[number]
type FetchHandler = (request: Request) => Promise<Response>

const feedRoute = (pathname: string): FeedRoute | undefined =>
  FEED_ROUTES.find((route) => route.path === pathname)

const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })

const requestTooLargeResponse = (): Response =>
  jsonResponse(
    {
      error: FeedErrorCode.InvalidRequest,
      message: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit; remove unnecessary feed parameters or other fields before retrying.`,
    },
    413,
  )

const methodNotAllowed = (expected: 'GET' | 'POST'): Response => {
  const response = jsonResponse(
    {
      error: FeedErrorCode.InvalidRequest,
      message: `This endpoint requires ${expected}; change the HTTP method and retry.`,
    },
    405,
  )
  response.headers.set('allow', expected)
  return response
}

const routeLabel = (pathname: string): string => {
  if (pathname === '/') return 'root'
  if (pathname === '/health') return 'health'
  if (pathname === '/ready') return 'ready'
  if (pathname === '/.well-known/did.json') return 'did_document'
  return feedRoute(pathname)?.label ?? 'other'
}

const withCorsHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', '*')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const corsPreflightResponse = (request: Request): Response => {
  const requestedMethod = request.headers.get('access-control-request-method')
  if (requestedMethod !== 'POST') {
    return jsonResponse(
      {
        error: FeedErrorCode.InvalidRequest,
        message:
          'This feed preflight must request POST; retry with the feed procedure method.',
      },
      400,
    )
  }

  const requestedHeaders = request.headers.get('access-control-request-headers')
  const unsupportedHeader = requestedHeaders
    ?.split(',')
    .map((value) => value.trim().toLowerCase())
    .find(
      (value) =>
        value !== '' && value !== 'content-type' && value !== 'authorization',
    )
  if (unsupportedHeader !== undefined) {
    return jsonResponse(
      {
        error: FeedErrorCode.InvalidRequest,
        message: `This feed preflight requests unsupported header ${JSON.stringify(unsupportedHeader)}; retry with content-type and authorization only.`,
      },
      400,
    )
  }

  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '600',
    },
  })
}

const readBoundedRequest = async (
  request: Request,
): Promise<Request | Response> => {
  const declaredLength = request.headers.get('content-length')
  if (
    declaredLength !== null &&
    Number(declaredLength) > MAX_REQUEST_BODY_BYTES
  ) {
    return requestTooLargeResponse()
  }
  if (request.body === null) return request

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel('request body limit exceeded')
      return requestTooLargeResponse()
    }
    chunks.push(value)
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  const headers = new Headers(request.headers)
  headers.set('content-length', String(size))
  // lex-server/nodejs aborts request.signal when the incoming body ends, even
  // on a successful upload (bluesky-social/atproto#5546). Do not pass that
  // stale signal to DID resolution. After buffering, client disconnects no
  // longer cancel auth/feed work; DID resolution and database timeouts remain.
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
  })
}

const rejectMalformedJson = async (
  request: Request,
): Promise<Response | undefined> => {
  try {
    await request.clone().json()
    return undefined
  } catch {
    return jsonResponse(
      {
        error: FeedErrorCode.InvalidRequest,
        message:
          'Request body is not valid JSON; correct the JSON syntax and retry.',
      },
      400,
    )
  }
}

const normalizeLexiconValidationError = async (
  response: Response,
  nsid: string | undefined,
): Promise<Response> => {
  if (nsid === undefined) return response
  if (response.status !== 400) return response
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return response

  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return response
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('error' in body) ||
    body.error !== FeedErrorCode.InvalidRequest
  ) {
    return response
  }
  const detail =
    'message' in body && typeof body.message === 'string'
      ? ` Details: ${body.message}`
      : ''
  return jsonResponse(
    {
      error: FeedErrorCode.InvalidRequest,
      message: `Request body does not match ${nsid}; correct the missing or invalid field and retry.${detail}`,
    },
    400,
  )
}

const observeResponseError = async (
  response: Response,
  metrics: Metrics,
): Promise<void> => {
  if (response.status < 400) return

  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('error' in body) ||
    typeof body.error !== 'string' ||
    !Object.values(FeedErrorCode).includes(body.error as FeedErrorCode)
  ) {
    return
  }
  metrics.observeError(body.error as FeedErrorCode)
}

const handleRootRequest = (request: Request): Response =>
  request.method === 'GET'
    ? jsonResponse({
        name: 'Hypercerts Feed Service',
        description: 'Read-only Hypercerts feeds over XRPC.',
        endpoints: FEED_ROUTES.map((route) => route.path),
      })
    : methodNotAllowed('GET')

const handleHealthRequest = (request: Request): Response =>
  request.method === 'GET'
    ? jsonResponse({ status: 'ok' })
    : methodNotAllowed('GET')

const handleDidDocumentRequest = (
  request: Request,
  serviceDid: string | undefined,
): Response => {
  const hostname = serviceDid?.match(/^did:web:([a-z0-9.-]+)$/)?.[1]
  if (hostname === undefined) {
    return new Response(null, { status: 404 })
  }
  if (request.method !== 'GET') return methodNotAllowed('GET')

  return jsonResponse({
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: serviceDid,
    service: [
      {
        id: '#hypercerts_feed',
        type: 'HypercertsFeedService',
        serviceEndpoint: `https://${hostname}`,
      },
    ],
  })
}

const handleReadyRequest = async (
  request: Request,
  database: DatabaseCompatibilityChecker,
  metrics: Metrics,
): Promise<Response> => {
  if (request.method !== 'GET') return methodNotAllowed('GET')

  const startedAt = performance.now()
  const compatibility = await database.checkCompatibility()
  metrics.observeDatabase('readiness', (performance.now() - startedAt) / 1_000)
  metrics.setReady(compatibility.compatible)
  return compatibility.compatible
    ? jsonResponse({ status: 'ready' })
    : jsonResponse({ status: 'not_ready', reason: compatibility.reason }, 503)
}

const handleFeedRequest = async (
  originalRequest: Request,
  matchedRoute: FeedRoute | undefined,
  router: LexRouter,
): Promise<Response> => {
  if (matchedRoute && originalRequest.method !== 'POST') {
    return methodNotAllowed('POST')
  }

  let request = originalRequest
  if (matchedRoute) {
    const bounded = await readBoundedRequest(originalRequest)
    if (bounded instanceof Response) {
      return bounded
    }
    request = bounded

    const malformedJson = await rejectMalformedJson(request)
    if (malformedJson) {
      return malformedJson
    }
  }

  const response = await router.fetch(request)
  return normalizeLexiconValidationError(response, matchedRoute?.nsid)
}

const handleRequest = async (
  request: Request,
  pathname: string,
  database: DatabaseCompatibilityChecker,
  router: LexRouter,
  metrics: Metrics,
  serviceDid: string | undefined,
): Promise<Response> => {
  const matchedFeedRoute = feedRoute(pathname)

  let response: Response
  if (matchedFeedRoute && request.method === 'OPTIONS') {
    response = corsPreflightResponse(request)
  } else if (pathname === '/') {
    response = handleRootRequest(request)
  } else if (pathname === '/health') {
    response = handleHealthRequest(request)
  } else if (pathname === '/ready') {
    response = await handleReadyRequest(request, database, metrics)
  } else if (pathname === '/.well-known/did.json') {
    response = handleDidDocumentRequest(request, serviceDid)
  } else {
    response = await handleFeedRequest(request, matchedFeedRoute, router)
  }

  return matchedFeedRoute ? withCorsHeaders(response) : response
}

/** Public feed services registered at the HTTP composition boundary. */
export interface AppFeedServices {
  readonly skeleton: FeedSkeletonReader
  readonly hydrated: HydratedFeedReader
}

/** Builds the fetch-style HTTP application containing XRPC and operational endpoints. */
export const createApp = (
  database: DatabaseCompatibilityChecker,
  services: AppFeedServices,
  metrics: Metrics,
  logger: Logger,
  auth?: OptionalServiceAuth,
  serviceDid?: string,
): { fetch: FetchHandler } => {
  const router = new LexRouter({
    onHandlerError: ({ error, method }) => {
      if (error instanceof LexServerError) return
      logger.error(
        { err: error, nsid: method.nsid },
        'unexpected XRPC handler error',
      )
    },
  })
  registerGetFeedSkeleton(router, services.skeleton, logger, auth)
  registerGetFeed(router, services.hydrated, logger, auth)

  const fetch: FetchHandler = async (request) => {
    const startedAt = performance.now()
    const pathname = new URL(request.url).pathname
    const matchedFeedRoute = feedRoute(pathname)
    const route = routeLabel(pathname)
    let status = 500
    try {
      const response = await handleRequest(
        request,
        pathname,
        database,
        router,
        metrics,
        serviceDid,
      )
      status = response.status
      if (matchedFeedRoute !== undefined) {
        await observeResponseError(response, metrics)
      }
      return response
    } finally {
      metrics.observeRequest(
        route,
        request.method,
        status,
        (performance.now() - startedAt) / 1_000,
      )
    }
  }

  return { fetch }
}
