import {
  LexServerAuthError,
  LexServerError,
  serviceAuth,
  type LexRouterAuth,
  type ServiceAuthCredentials,
  type ServiceAuthOptions,
} from '@atproto/lex-server'
import { createDidResolver } from '@atproto-labs/did-resolver'
import { safeFetchWrap } from '@atproto-labs/fetch-node'
import type { Config } from '../config.js'

export type OptionalServiceAuth = LexRouterAuth<
  ServiceAuthCredentials | undefined
>

type OptionalServiceAuthOptions = Omit<ServiceAuthOptions, 'unique'>
const MAX_REPLAY_ENTRIES = 4_096
const MAX_REPLAY_ENTRIES_PER_ISSUER = 512
const authChallenge = {
  Bearer: { error: 'BadJwtLexiconMethod' },
} as const
const badJwtChallenge = {
  Bearer: { error: 'BadJwt' },
} as const
const replayChallenge = {
  Bearer: { error: 'NonceNotUnique' },
} as const
const textEncoder = new TextEncoder()

const expiredTokenError = (): LexServerAuthError =>
  new LexServerAuthError('AuthenticationRequired', 'JWT token expired', {
    Bearer: { error: 'JwtExpired' },
  })

type VerifiedServiceAuthPayload = ServiceAuthCredentials['jwt']['payload'] & {
  readonly jti?: unknown
}

interface ReplayProtector {
  consume: (issuerDid: string, jti: string, exp: number) => void
}

const assertEndpointBinding = (
  payload: ServiceAuthCredentials['jwt']['payload'],
  methodNsid: string,
): void => {
  if (payload.lxm !== methodNsid) {
    throw new LexServerAuthError(
      'AuthenticationRequired',
      'JWT lexicon method is missing or does not match this endpoint; request a token with the exact endpoint NSID in lxm.',
      authChallenge,
    )
  }
}

const validateJti = (payload: VerifiedServiceAuthPayload): string => {
  const jti = payload.jti
  if (
    typeof jti !== 'string' ||
    jti.length === 0 ||
    textEncoder.encode(jti).byteLength > 256
  ) {
    throw new LexServerAuthError(
      'AuthenticationRequired',
      'JWT jti must be a non-empty string no longer than 256 UTF-8 bytes; request a token with a valid jti.',
      badJwtChallenge,
    )
  }
  return jti
}

const createReplayProtector = (): ReplayProtector => {
  const replayEntriesByIssuer = new Map<string, Map<string, number>>()
  let replayEntryCount = 0
  let lastObservedWallMs = 0

  const removeReplayEntry = (
    issuerDid: string,
    jti: string,
    issuerEntries: Map<string, number>,
  ): void => {
    if (!issuerEntries.delete(jti)) return
    replayEntryCount -= 1
    if (issuerEntries.size === 0) {
      replayEntriesByIssuer.delete(issuerDid)
    }
  }

  const purgeExpiredIssuerEntries = (
    issuerDid: string,
    issuerEntries: Map<string, number>,
  ): void => {
    for (const [storedJti, expiry] of issuerEntries) {
      if (expiry <= lastObservedWallMs) {
        removeReplayEntry(issuerDid, storedJti, issuerEntries)
      }
    }
  }

  const purgeExpiredEntries = (): void => {
    for (const [issuerDid, issuerEntries] of replayEntriesByIssuer) {
      purgeExpiredIssuerEntries(issuerDid, issuerEntries)
    }
  }

  const getCurrentTimeMs = (): number => {
    lastObservedWallMs = Math.max(Date.now(), lastObservedWallMs)
    return lastObservedWallMs
  }

  const assertTokenIsLive = (expiresAt: number, nowMs: number): void => {
    if (expiresAt <= nowMs) {
      throw expiredTokenError()
    }
  }

  const rejectReplayAndGetEntries = (
    issuerDid: string,
    jti: string,
    nowMs: number,
  ): Map<string, number> | undefined => {
    const issuerEntries = replayEntriesByIssuer.get(issuerDid)
    if (issuerEntries === undefined) return undefined

    const storedExpiry = issuerEntries.get(jti)
    if (storedExpiry === undefined) return issuerEntries
    if (storedExpiry > nowMs) {
      throw new LexServerAuthError(
        'AuthenticationRequired',
        'Replay attack detected: token is not unique; request a fresh token.',
        replayChallenge,
      )
    }

    removeReplayEntry(issuerDid, jti, issuerEntries)
    return replayEntriesByIssuer.get(issuerDid)
  }

  const ensureIssuerCapacity = (
    issuerDid: string,
    issuerEntries: Map<string, number> | undefined,
  ): Map<string, number> | undefined => {
    if (
      issuerEntries === undefined ||
      issuerEntries.size < MAX_REPLAY_ENTRIES_PER_ISSUER
    ) {
      return issuerEntries
    }

    purgeExpiredIssuerEntries(issuerDid, issuerEntries)
    issuerEntries = replayEntriesByIssuer.get(issuerDid)
    if (
      issuerEntries !== undefined &&
      issuerEntries.size >= MAX_REPLAY_ENTRIES_PER_ISSUER
    ) {
      throw new LexServerError(503, {
        error: 'InternalError',
        message:
          'Authentication replay protection reached the per-issuer limit; retry later with a fresh token.',
      })
    }
    return issuerEntries
  }

  const ensureGlobalCapacity = (): void => {
    if (replayEntryCount < MAX_REPLAY_ENTRIES) return

    purgeExpiredEntries()
    if (replayEntryCount >= MAX_REPLAY_ENTRIES) {
      throw new LexServerError(503, {
        error: 'InternalError',
        message:
          'Authentication replay protection is temporarily at capacity; retry later with a fresh token.',
      })
    }
  }

  const storeReplayEntry = (
    issuerDid: string,
    jti: string,
    expiresAt: number,
    issuerEntries: Map<string, number> | undefined,
  ): void => {
    issuerEntries ??= new Map<string, number>()
    replayEntriesByIssuer.set(issuerDid, issuerEntries)
    issuerEntries.set(jti, expiresAt)
    replayEntryCount += 1
  }

  const consume = (issuerDid: string, jti: string, exp: number): void => {
    const nowMs = getCurrentTimeMs()
    const expiresAt = (exp + 1) * 1_000
    assertTokenIsLive(expiresAt, nowMs)

    let issuerEntries = rejectReplayAndGetEntries(issuerDid, jti, nowMs)
    issuerEntries = ensureIssuerCapacity(issuerDid, issuerEntries)
    ensureGlobalCapacity()
    storeReplayEntry(issuerDid, jti, expiresAt, issuerEntries)
  }

  return { consume }
}

/**
 * Makes AT Protocol service authentication optional without treating malformed
 * credentials as anonymous requests. The built-in verifier handles signature,
 * audience, expiry, DID resolution, and key rotation. Verified tokens are
 * replay-protected in a bounded cache local to this auth instance and process.
 */
export const createOptionalServiceAuth = (
  options: OptionalServiceAuthOptions,
): OptionalServiceAuth => {
  // The upstream callback checks a non-canonical nonce before signature
  // verification. Keep it side-effect-free; canonical jti state is recorded
  // only after the built-in verifier and the exact endpoint check succeed.
  const verify = serviceAuth({
    ...options,
    unique: () => Promise.resolve(true),
  })
  const replayProtector = createReplayProtector()

  return async (context) => {
    if (context.request.headers.get('authorization') === null) {
      return undefined
    }

    const credentials = await verify(context)
    assertEndpointBinding(credentials.jwt.payload, context.method.nsid)

    const payload = credentials.jwt.payload as VerifiedServiceAuthPayload
    const jti = validateJti(payload)
    replayProtector.consume(credentials.did, jti, payload.exp)
    return credentials
  }
}

/** Builds the production auth verifier and its bounded DID resolver. */
export const createConfiguredServiceAuth = (
  config: Pick<
    Config,
    'serviceDid' | 'serviceAuthMaxAgeSeconds' | 'didResolutionTimeoutMs'
  >,
): OptionalServiceAuth => {
  const didResolver = createDidResolver({
    allowHttp: false,
    fetch: safeFetchWrap({
      responseMaxSize: 128 * 1024,
      ssrfProtection: true,
      allowHttp: false,
      allowCustomPort: false,
      allowIpHost: false,
      allowPrivateIps: false,
      timeout: config.didResolutionTimeoutMs,
      allowImplicitRedirect: false,
    }),
  })

  // lex-server currently rejects Proposal 0014 did#serviceId audiences.
  // Keep the bare-DID audience until upstream can accept both forms explicitly.
  return createOptionalServiceAuth({
    audience: config.serviceDid,
    maxAge: config.serviceAuthMaxAgeSeconds,
    didResolver,
  })
}

export type { ServiceAuthCredentials }
