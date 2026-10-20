import { P256Keypair, bytesToMultibase } from '@atproto/crypto'
import { LexServerAuthError } from '@atproto/lex-server'
import type {
  AtprotoIdentityDidMethods,
  Did,
  DidResolver,
  ResolvedDocument,
} from '@atproto-labs/did-resolver'
import { describe, expect, it, vi } from 'vitest'

import {
  createOptionalServiceAuth,
  type OptionalServiceAuth,
  type ServiceAuthCredentials,
} from '../src/auth/service-auth.js'
import { main as hydratedMethod } from '../src/lexicons/org/hypercerts/feed/getFeed.defs.js'
import { main as skeletonMethod } from '../src/lexicons/org/hypercerts/feed/getFeedSkeleton.defs.js'

const issuerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const otherIssuerDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const serviceDid = 'did:web:feed.example'
const skeletonNsid = 'org.hypercerts.feed.getFeedSkeleton'
const hydratedNsid = 'org.hypercerts.feed.getFeed'
const baseTimeMs = 1_700_000_000_000

let nextJti = 0

const now = (): number => Math.floor(Date.now() / 1_000)

const freshJti = (): string => `test-jti-${String(++nextJti)}`

const itemAt = <T>(items: readonly T[], index: number): T => {
  const item = items[index]
  if (item === undefined) {
    throw new Error(`Expected a test fixture at index ${String(index)}`)
  }
  return item
}

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

const signedJwt = async (
  keypair: P256Keypair,
  overrides: Record<string, unknown> = {},
): Promise<string> => {
  const payload = {
    iss: issuerDid,
    aud: serviceDid,
    iat: now(),
    exp: now() + 60,
    lxm: skeletonNsid,
    jti: freshJti(),
    ...overrides,
  }
  const message = `${encode({ alg: keypair.jwtAlg, typ: 'JWT' })}.${encode(payload)}`
  const signature = await keypair.sign(new TextEncoder().encode(message))
  return `${message}.${Buffer.from(signature).toString('base64url')}`
}

const resolverForMany = (
  ...entries: readonly (readonly [string, P256Keypair])[]
): DidResolver<AtprotoIdentityDidMethods> => ({
  resolve: <D extends Did>(
    did: D,
  ): Promise<ResolvedDocument<D, AtprotoIdentityDidMethods>> => {
    const entry = entries.find(([entryDid]) => entryDid === did)
    if (entry === undefined) {
      return Promise.reject(new Error('unknown test issuer'))
    }

    const [, keypair] = entry
    // @ts-expect-error -- DidResolver's conditional return type cannot correlate D with this matching fixture document.
    return Promise.resolve({
      id: did,
      verificationMethod: [
        {
          id: `${did}#atproto`,
          type: 'EcdsaSecp256r1VerificationKey2019',
          controller: did,
          publicKeyMultibase: bytesToMultibase(
            keypair.publicKeyBytes(),
            'base58btc',
          ),
        },
      ],
    })
  },
})

const resolverFor = (
  keypair: P256Keypair,
  did = issuerDid,
): DidResolver<AtprotoIdentityDidMethods> => resolverForMany([did, keypair])

const authRequest = (authorization: string | undefined): Request =>
  new Request('http://localhost/xrpc/test', {
    headers: authorization === undefined ? {} : { authorization },
  })

const authContext = (
  authorization: string | undefined,
  nsid = skeletonNsid,
): Parameters<OptionalServiceAuth>[0] => ({
  request: authRequest(authorization),
  method: nsid === hydratedNsid ? hydratedMethod : skeletonMethod,
  params: {},
})

describe('optional AT Protocol service authentication', () => {
  it('returns anonymous credentials only when Authorization is absent', async () => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })

    await expect(auth(authContext(undefined))).resolves.toBeUndefined()
  })

  it('verifies a signed #atproto JWT and binds it to the endpoint', async () => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const token = await signedJwt(keypair)

    await expect(auth(authContext(`Bearer ${token}`))).resolves.toMatchObject({
      did: issuerDid,
    })
  })

  it.each([
    ['wrong signature', async () => signedJwt(await P256Keypair.create())],
    [
      'expired token',
      async (keypair: P256Keypair) => signedJwt(keypair, { exp: now() - 1 }),
    ],
    [
      'not-yet-valid token',
      async (keypair: P256Keypair) => signedJwt(keypair, { nbf: now() + 60 }),
    ],
    [
      'wrong audience',
      async (keypair: P256Keypair) =>
        signedJwt(keypair, { aud: 'did:web:other.example' }),
    ],
    [
      'missing lxm',
      async (keypair: P256Keypair) => signedJwt(keypair, { lxm: undefined }),
    ],
    [
      'wrong lxm',
      async (keypair: P256Keypair) => signedJwt(keypair, { lxm: hydratedNsid }),
    ],
  ])('rejects %s without anonymous fallback', async (_label, makeToken) => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const token = await makeToken(keypair)

    await expect(auth(authContext(`Bearer ${token}`))).rejects.toBeInstanceOf(
      LexServerAuthError,
    )
  })

  it('rejects a present malformed Authorization header', async () => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })

    await expect(auth(authContext('Basic credentials'))).rejects.toBeInstanceOf(
      LexServerAuthError,
    )
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['wrong type number', 123],
    ['wrong type boolean', true],
    ['wrong type object', {}],
    ['257 UTF-8 bytes', `${'é'.repeat(128)}a`],
  ])('rejects a %s jti', async (_label, jti) => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const token = await signedJwt(keypair, { jti })

    await expect(auth(authContext(`Bearer ${token}`))).rejects.toMatchObject({
      error: 'AuthenticationRequired',
      status: 401,
      wwwAuthenticate: { Bearer: { error: 'BadJwt' } },
    })
  })

  it('accepts a 256-byte Unicode jti', async () => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const token = await signedJwt(keypair, { jti: 'é'.repeat(128) })

    await expect(auth(authContext(`Bearer ${token}`))).resolves.toMatchObject({
      did: issuerDid,
    })
  })

  it('does not trim a nonempty whitespace jti', async () => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const token = await signedJwt(keypair, { jti: ' ' })

    await expect(auth(authContext(`Bearer ${token}`))).resolves.toMatchObject({
      did: issuerDid,
    })
  })

  it('rejects a duplicate issuer and jti with the upstream replay challenge', async () => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const token = await signedJwt(keypair, { jti: 'duplicate-jti' })

    await expect(auth(authContext(`Bearer ${token}`))).resolves.toBeDefined()
    await expect(auth(authContext(`Bearer ${token}`))).rejects.toMatchObject({
      error: 'AuthenticationRequired',
      status: 401,
      wwwAuthenticate: { Bearer: { error: 'NonceNotUnique' } },
    })
  })

  it('isolates the same jti between verified issuers', async () => {
    const firstKeypair = await P256Keypair.create()
    const secondKeypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverForMany(
        [issuerDid, firstKeypair],
        [otherIssuerDid, secondKeypair],
      ),
    })
    const firstToken = await signedJwt(firstKeypair, { jti: 'shared-jti' })
    const secondToken = await signedJwt(secondKeypair, {
      iss: otherIssuerDid,
      jti: 'shared-jti',
    })

    await expect(
      auth(authContext(`Bearer ${firstToken}`)),
    ).resolves.toMatchObject({
      did: issuerDid,
    })
    await expect(
      auth(authContext(`Bearer ${secondToken}`)),
    ).resolves.toMatchObject({
      did: otherIssuerDid,
    })
    await expect(
      auth(authContext(`Bearer ${firstToken}`)),
    ).rejects.toMatchObject({
      wwwAuthenticate: { Bearer: { error: 'NonceNotUnique' } },
    })
  })

  it('caps each verified issuer at 512 entries without consuming another issuer quota', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(baseTimeMs)
      const firstKeypair = await P256Keypair.create()
      const secondKeypair = await P256Keypair.create()
      const auth = createOptionalServiceAuth({
        audience: serviceDid,
        didResolver: resolverForMany(
          [issuerDid, firstKeypair],
          [otherIssuerDid, secondKeypair],
        ),
      })
      const firstTokens = await Promise.all(
        Array.from({ length: 513 }, (_, index) =>
          signedJwt(firstKeypair, {
            exp: now() + 1,
            jti: `first-issuer-jti-${String(index)}`,
          }),
        ),
      )

      for (const token of firstTokens.slice(0, 512)) {
        await expect(
          auth(authContext(`Bearer ${token}`)),
        ).resolves.toMatchObject({
          did: issuerDid,
        })
      }
      const issuerOverflow = auth(
        authContext(`Bearer ${itemAt(firstTokens, 512)}`),
      )
      await expect(issuerOverflow).rejects.toThrow('issuer')
      await expect(issuerOverflow).rejects.toMatchObject({
        error: 'InternalError',
        status: 503,
      })

      const secondTokens = await Promise.all(
        Array.from({ length: 512 }, (_, index) =>
          signedJwt(secondKeypair, {
            iss: otherIssuerDid,
            jti: `second-issuer-jti-${String(index)}`,
          }),
        ),
      )
      for (const token of secondTokens) {
        await expect(
          auth(authContext(`Bearer ${token}`)),
        ).resolves.toMatchObject({
          did: otherIssuerDid,
        })
      }

      vi.setSystemTime(baseTimeMs + 2_000)
      const afterExpiryToken = await signedJwt(firstKeypair, {
        jti: 'first-issuer-after-expiry',
      })
      await expect(
        auth(authContext(`Bearer ${afterExpiryToken}`)),
      ).resolves.toMatchObject({ did: issuerDid })
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('does not let a forged signature consume a valid token jti', async () => {
    const keypair = await P256Keypair.create()
    const forgedKeypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const forgedToken = await signedJwt(forgedKeypair, { jti: 'forged-jti' })
    const validToken = await signedJwt(keypair, { jti: 'forged-jti' })

    await expect(
      auth(authContext(`Bearer ${forgedToken}`)),
    ).rejects.toMatchObject({
      wwwAuthenticate: { Bearer: { error: 'BadJwtSignature' } },
    })
    await expect(
      auth(authContext(`Bearer ${validToken}`)),
    ).resolves.toMatchObject({
      did: issuerDid,
    })
  })

  it.each([
    ['missing', undefined],
    ['wrong', hydratedNsid],
  ])('does not let a %s lxm consume a valid token jti', async (_label, lxm) => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const invalidToken = await signedJwt(keypair, {
      jti: 'endpoint-jti',
      lxm,
    })
    const validToken = await signedJwt(keypair, { jti: 'endpoint-jti' })

    await expect(
      auth(authContext(`Bearer ${invalidToken}`)),
    ).rejects.toBeInstanceOf(LexServerAuthError)
    await expect(
      auth(authContext(`Bearer ${validToken}`)),
    ).resolves.toMatchObject({
      did: issuerDid,
    })
  })

  it('shares replay state between the skeleton and hydrated endpoints', async () => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const skeletonToken = await signedJwt(keypair, {
      jti: 'both-endpoints-jti',
      lxm: skeletonNsid,
    })
    const hydratedToken = await signedJwt(keypair, {
      jti: 'both-endpoints-jti',
      lxm: hydratedNsid,
    })

    await expect(
      auth(authContext(`Bearer ${skeletonToken}`, skeletonNsid)),
    ).resolves.toBeDefined()
    await expect(
      auth(authContext(`Bearer ${hydratedToken}`, hydratedNsid)),
    ).rejects.toMatchObject({
      wwwAuthenticate: { Bearer: { error: 'NonceNotUnique' } },
    })
  })

  it('allows only one concurrent authentication for a token', async () => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const token = await signedJwt(keypair, { jti: 'concurrent-jti' })
    const results = await Promise.allSettled([
      auth(authContext(`Bearer ${token}`)),
      auth(authContext(`Bearer ${token}`)),
    ])
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<ServiceAuthCredentials | undefined> =>
        result.status === 'fulfilled',
    )
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({
      wwwAuthenticate: { Bearer: { error: 'NonceNotUnique' } },
    })
  })

  it('consumes a token even when the downstream request fails', async () => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const token = await signedJwt(keypair, { jti: 'downstream-failure-jti' })
    const request = authContext(`Bearer ${token}`)

    await expect(
      (async () => {
        await auth(request)
        throw new Error('downstream failure')
      })(),
    ).rejects.toThrow('downstream failure')
    await expect(auth(request)).rejects.toMatchObject({
      wwwAuthenticate: { Bearer: { error: 'NonceNotUnique' } },
    })
  })

  it('rejects a token that expires during asynchronous verification', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(baseTimeMs)
      const keypair = await P256Keypair.create()
      let releaseResolution!: () => void
      let markResolutionStarted!: () => void
      const resolutionStarted = new Promise<void>((resolve) => {
        markResolutionStarted = resolve
      })
      const resolutionReleased = new Promise<void>((resolve) => {
        releaseResolution = resolve
      })
      const resolver: DidResolver<AtprotoIdentityDidMethods> = {
        resolve: async (did) => {
          markResolutionStarted()
          await resolutionReleased
          return resolverFor(keypair).resolve(did)
        },
      }
      const auth = createOptionalServiceAuth({
        audience: serviceDid,
        didResolver: resolver,
      })
      const token = await signedJwt(keypair, {
        exp: now() + 1,
        jti: 'delayed-expiry-jti',
      })
      const pending = auth(authContext(`Bearer ${token}`))

      await resolutionStarted
      vi.setSystemTime(baseTimeMs + 2_000)
      releaseResolution()

      await expect(pending).rejects.toMatchObject({
        error: 'AuthenticationRequired',
        message: 'JWT token expired',
        wwwAuthenticate: { Bearer: { error: 'JwtExpired' } },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains a token through the complete exp second', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(baseTimeMs)
      const keypair = await P256Keypair.create()
      const auth = createOptionalServiceAuth({
        audience: serviceDid,
        didResolver: resolverFor(keypair),
      })
      const token = await signedJwt(keypair, {
        exp: now() + 1,
        jti: 'expiry-boundary-jti',
      })

      await expect(auth(authContext(`Bearer ${token}`))).resolves.toBeDefined()
      vi.setSystemTime(baseTimeMs + 1_999)
      await expect(auth(authContext(`Bearer ${token}`))).rejects.toMatchObject({
        wwwAuthenticate: { Bearer: { error: 'NonceNotUnique' } },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('purges expired entries at capacity, fails closed for live entries, and resists clock rollback', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(baseTimeMs)
      const capacityIssuerDids = [
        issuerDid,
        otherIssuerDid,
        ...Array.from(
          { length: 7 },
          (_, index) =>
            `did:plc:${'a'.repeat(23)}${String.fromCharCode(98 + index)}`,
        ),
      ]
      const capacityKeypairs = await Promise.all(
        Array.from({ length: capacityIssuerDids.length }, () =>
          P256Keypair.create(),
        ),
      )
      const auth = createOptionalServiceAuth({
        audience: serviceDid,
        didResolver: resolverForMany(
          ...capacityIssuerDids.map(
            (did, index): readonly [string, P256Keypair] => [
              did,
              itemAt(capacityKeypairs, index),
            ],
          ),
        ),
      })
      const tokens = await Promise.all(
        Array.from({ length: 4_096 }, (_, index) => {
          const issuerIndex = Math.floor(index / 512)
          return signedJwt(itemAt(capacityKeypairs, issuerIndex), {
            iss: itemAt(capacityIssuerDids, issuerIndex),
            exp: now() + 60,
            jti: `capacity-jti-${String(index)}`,
          })
        }),
      )

      for (const token of tokens) {
        await auth(authContext(`Bearer ${token}`))
      }

      const overflowToken = await signedJwt(itemAt(capacityKeypairs, 8), {
        iss: itemAt(capacityIssuerDids, 8),
        jti: 'overflow-jti',
      })
      const globalOverflow = auth(authContext(`Bearer ${overflowToken}`))
      await expect(globalOverflow).rejects.toThrow('at capacity')
      await expect(globalOverflow).rejects.toMatchObject({
        error: 'InternalError',
        status: 503,
      })
      await expect(
        auth(authContext(`Bearer ${itemAt(tokens, 0)}`)),
      ).rejects.toMatchObject({
        wwwAuthenticate: { Bearer: { error: 'NonceNotUnique' } },
      })

      vi.setSystemTime(baseTimeMs + 61_000)
      const freshToken = await signedJwt(itemAt(capacityKeypairs, 0), {
        exp: now() + 60,
        jti: 'after-purge-jti',
      })
      await expect(
        auth(authContext(`Bearer ${freshToken}`)),
      ).resolves.toBeDefined()

      vi.setSystemTime(baseTimeMs + 60_500)
      await expect(
        auth(authContext(`Bearer ${itemAt(tokens, 0)}`)),
      ).rejects.toMatchObject({
        error: 'AuthenticationRequired',
        message: 'JWT token expired',
        wwwAuthenticate: { Bearer: { error: 'JwtExpired' } },
      })
    } finally {
      vi.useRealTimers()
    }
    // Use real signed tokens here so the production verifier and hard cap are
    // exercised together; the explicit timeout covers 4,096 signatures.
  }, 30_000)
})
