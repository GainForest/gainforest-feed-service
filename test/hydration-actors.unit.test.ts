import { jsonToLex } from '@atproto/lex'
import type { QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import {
  type IdentityQueryExecutor,
  PostgresIdentityReader,
} from '../src/hydration/identity.js'
import {
  isMeaningfulCertifiedProfile,
  validateCertifiedProfile,
} from '../src/hydration/validation.js'
import { buildActorSummary } from '../src/hydration/views.js'

const didA = 'did:plc:abcdefghijklmnopqrstuvwx'
const didB = 'did:plc:zyxwvutsrqponmlkjihgfedc'
const didC = 'did:plc:bcdefghijklmnopqrstuvwxy'
const didD = 'did:plc:cdefghijklmnopqrstuvwxyz'
const blobCid = 'bafkreiehxpuhtr5f6v4eu4byjo2j7kkrhjvd7psmfu4imnpdzb3bdqb7vy'
const createdAt = '2026-07-20T00:00:00.000Z'

class FakeQueryExecutor implements IdentityQueryExecutor {
  readonly calls: {
    readonly text: string
    readonly values: readonly unknown[]
  }[] = []

  constructor(
    private readonly resultRows: readonly Record<string, unknown>[],
    private readonly failure?: Error,
  ) {}

  async query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly T[] }> {
    this.calls.push({ text, values })
    if (this.failure) throw this.failure
    return { rows: this.resultRows as unknown as readonly T[] }
  }
}

const profile = (overrides: Record<string, unknown> = {}): unknown => ({
  $type: 'app.certified.actor.profile',
  createdAt,
  ...overrides,
})

const blobImage = (
  overrides: Record<string, unknown> = {},
  variant: 'smallImage' | 'largeImage' = 'smallImage',
): unknown => ({
  $type: `org.hypercerts.defs#${variant}`,
  image: {
    $type: 'blob',
    ref: { $link: blobCid },
    mimeType: 'image/png',
    size: 128,
    ...overrides,
  },
})

const protocolValue = (value: unknown): unknown =>
  jsonToLex(value as Parameters<typeof jsonToLex>[0], { strict: true })

const identityResultRow = (
  requestedDid: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  requested_did: requestedDid,
  certified_profile_json: null,
  ...overrides,
})

describe('PostgresIdentityReader', () => {
  it('avoids PostgreSQL for an empty batch', async () => {
    const database = new FakeQueryExecutor([])
    const reader = new PostgresIdentityReader(database)

    await expect(reader.getByDids([])).resolves.toEqual(new Map())
    expect(database.calls).toEqual([])
  })

  it('returns a DID-only context for every requested DID when storage rows are absent', async () => {
    const database = new FakeQueryExecutor([])
    const reader = new PostgresIdentityReader(database)

    await expect(reader.getByDids([didA, didB])).resolves.toEqual(
      new Map([
        [didA, { did: didA }],
        [didB, { did: didB }],
      ]),
    )
    expect(database.calls).toHaveLength(1)
  })

  it('decodes Certified profile TEXT and returns DID-only contexts for malformed JSON', async () => {
    const rawCertifiedA = profile({ displayName: 'Certified Alice' })
    const rawCertifiedC = profile({ description: 'Certified profile only' })
    const database = new FakeQueryExecutor([
      identityResultRow(didD, {
        certified_profile_json: '{malformed-json',
      }),
      identityResultRow(didC, {
        certified_profile_json: JSON.stringify(rawCertifiedC),
      }),
      identityResultRow(didB),
      identityResultRow(didA, {
        certified_profile_json: JSON.stringify(rawCertifiedA),
      }),
    ])
    const reader = new PostgresIdentityReader(database)

    await expect(
      reader.getByDids([didA, didB, didC, didD, didA]),
    ).resolves.toEqual(
      new Map([
        [didA, { did: didA, certifiedProfile: rawCertifiedA }],
        [didB, { did: didB }],
        [didC, { did: didC, certifiedProfile: rawCertifiedC }],
        [didD, { did: didD }],
      ]),
    )

    expect(database.calls).toHaveLength(1)
    expect(database.calls[0]?.values).toEqual([[didA, didB, didC, didD]])
  })

  it('rejects duplicate result rows for the same requested DID', async () => {
    const reader = new PostgresIdentityReader(
      new FakeQueryExecutor([
        identityResultRow(didA),
        identityResultRow(didA, {
          certified_profile_json: profile({ displayName: 'Duplicate' }),
        }),
      ]),
    )

    await expect(reader.getByDids([didA])).rejects.toThrow(
      /duplicate result rows.*same requested DID.*identity joins/i,
    )
  })

  it('rejects a result row for an unrequested DID', async () => {
    const reader = new PostgresIdentityReader(
      new FakeQueryExecutor([identityResultRow(didB)]),
    )

    await expect(reader.getByDids([didA])).rejects.toThrow(
      /unrequested DID.*requested-DID projection and bind order/i,
    )
  })

  it('propagates PostgreSQL rejection without returning partial contexts', async () => {
    const database = new FakeQueryExecutor(
      [],
      new Error('identity query failed'),
    )
    const reader = new PostgresIdentityReader(database)

    await expect(reader.getByDids([didA, didB])).rejects.toThrow(
      'identity query failed',
    )
    expect(database.calls).toHaveLength(1)
  })
})

describe('Certified profile validation', () => {
  it('accepts valid v1.0.0 profiles and rejects malformed or wrong-type records', () => {
    expect(
      validateCertifiedProfile(profile({ displayName: 'Alice' })),
    ).toMatchObject({
      $type: 'app.certified.actor.profile',
      displayName: 'Alice',
    })
    expect(validateCertifiedProfile(null)).toBeUndefined()
    expect(
      validateCertifiedProfile({ createdAt, displayName: 'Alice' }),
    ).toBeUndefined()
    expect(
      validateCertifiedProfile({
        $type: 'app.certified.actor.profile',
        displayName: 'Alice',
      }),
    ).toBeUndefined()
    expect(
      validateCertifiedProfile(
        profile({ $type: 'app.bsky.actor.profile', displayName: 'Alice' }),
      ),
    ).toBeUndefined()
  })

  it('rejects invalid image variants before profile fields are exposed', () => {
    expect(
      validateCertifiedProfile(
        profile({
          displayName: 'Untrusted',
          avatar: {
            $type: 'org.hypercerts.defs#uri',
            uri: 'not a URI',
          },
        }),
      ),
    ).toBeUndefined()
    expect(
      validateCertifiedProfile(
        profile({
          displayName: 'Untrusted',
          avatar: blobImage({ ref: { $link: 'not-a-cid' } }),
        }),
      ),
    ).toBeUndefined()
  })

  it('enforces v1.0.0 constraints for supported profile blobs', () => {
    const invalidProfiles = [
      profile({ avatar: blobImage({ size: -1 }) }),
      profile({ avatar: blobImage({ size: 1.5 }) }),
      profile({ avatar: blobImage({ mimeType: 'application/pdf' }) }),
      profile({ avatar: blobImage({ size: 5_242_881 }) }),
      profile({ banner: blobImage({ size: 10_485_761 }, 'largeImage') }),
      JSON.parse(
        JSON.stringify(profile({ avatar: blobImage({ size: undefined }) })),
      ),
    ]

    for (const invalid of invalidProfiles) {
      expect(validateCertifiedProfile(invalid)).toBeUndefined()
    }
  })

  it('preserves validator-accepted unknown image unions without projecting them', () => {
    const validated = validateCertifiedProfile(
      profile({
        avatar: {
          $type: 'example.feed.futureImage',
          value: 'future',
        },
      }),
    )

    expect(validated).toBeDefined()
    expect(buildActorSummary(didA, validated)).toEqual({ did: didA })
  })

  it('treats all six supported fields as meaningful only after validation', () => {
    const empty = validateCertifiedProfile(profile())
    const meaningfulProfiles = [
      profile({ displayName: 'Alice' }),
      profile({ description: 'Certified bio' }),
      profile({
        avatar: {
          $type: 'org.hypercerts.defs#uri',
          uri: 'https://example.com/avatar.png',
        },
      }),
      profile({
        banner: {
          $type: 'org.hypercerts.defs#uri',
          uri: 'https://example.com/banner.png',
        },
      }),
      profile({ pronouns: 'they/them' }),
      profile({ website: 'https://example.com' }),
    ]

    expect(empty && isMeaningfulCertifiedProfile(empty)).toBe(false)
    for (const raw of meaningfulProfiles) {
      const validated = validateCertifiedProfile(raw)
      expect(validated && isMeaningfulCertifiedProfile(validated)).toBe(true)
    }
  })
})

describe('buildActorSummary', () => {
  it('projects display and avatar fields from a meaningful Certified profile', () => {
    const certified = validateCertifiedProfile(
      profile({ displayName: 'Certified Alice' }),
    )

    expect(buildActorSummary(didA, certified)).toEqual({
      did: didA,
      displayName: 'Certified Alice',
    })
  })

  it('returns DID-only identity when no displayable Certified fields exist', () => {
    const profiles = [
      undefined,
      validateCertifiedProfile(profile()),
      validateCertifiedProfile(
        profile({ $type: 'app.bsky.actor.profile', displayName: 'Untrusted' }),
      ),
      validateCertifiedProfile(profile({ avatar: blobImage({ size: -1 }) })),
      validateCertifiedProfile(profile({ website: 'https://example.com' })),
      validateCertifiedProfile(profile({ description: 'Certified bio' })),
    ]

    for (const certified of profiles) {
      expect(buildActorSummary(didA, certified)).toEqual({ did: didA })
    }
  })

  it('preserves Certified URI and small-image avatar variants', () => {
    const uriProfile = validateCertifiedProfile(
      profile({
        avatar: {
          $type: 'org.hypercerts.defs#uri',
          uri: 'https://example.com/avatar.png',
        },
      }),
    )
    const blobProfile = validateCertifiedProfile(
      JSON.parse(JSON.stringify(profile({ avatar: blobImage() }))),
    )

    expect(buildActorSummary(didA, uriProfile).avatar).toEqual({
      $type: 'org.hypercerts.defs#uri',
      uri: 'https://example.com/avatar.png',
    })
    expect(buildActorSummary(didA, blobProfile).avatar).toEqual(
      protocolValue(blobImage()),
    )
  })
})
