import { describe, expect, it } from 'vitest'

import type {
  FeedPageLoader,
  FeedPageMode,
  InternalFeedPage,
  InternalFeedRow,
  InternalSourceFeedRow,
} from '../src/feed/registry.js'
import {
  HYPERCERTS_FEED_ID,
  HYPERCERTS_FEED_PARAMS_TYPE,
  type HypercertsFeedParams,
  type GetFeedSkeletonInput,
} from '../src/feed/types.js'
import { HydratedFeedService } from '../src/hydration/service.js'
import type { ActorContext, IdentityReader } from '../src/hydration/types.js'

const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const authorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const invalidAuthorDid = 'did:plc:abcdefghijklmnopqrstuvwx'
const endorsedDid = 'did:plc:zyxwvutsrqponmlkjihgfedc'
const targetDid = 'did:plc:bcdefghijklmnopqrstuvwxy'
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const definitionCid =
  'bafyreifxcn6ts5hr6oequ5w5jyrpwrdl6p5lq46jasnxmcw3h3sme6asru'
const createdAt = '2026-07-20T00:00:00.000Z'
const cursor = 'opaque-cursor-bytes'

const activityUri = `at://${authorDid}/org.hypercerts.claim.activity/activity`
const invalidUri = `at://${invalidAuthorDid}/org.hypercerts.collection/invalid`
const endorsementUri = `at://${authorDid}/app.certified.badge.award/endorsement`
const measurementUri = `at://${authorDid}/org.hypercerts.context.measurement/measurement`
const targetUri = `at://${targetDid}/org.hypercerts.claim.activity/target`

type FeedRequestOverrides = Partial<
  Omit<HypercertsFeedParams, '$type' | 'viewerDid'>
> &
  Pick<GetFeedSkeletonInput, 'limit' | 'cursor'>

const feedRequest = (
  overrides: FeedRequestOverrides = {},
): GetFeedSkeletonInput => {
  const { limit, cursor, ...params } = overrides
  return {
    feedId: HYPERCERTS_FEED_ID,
    params: {
      $type: HYPERCERTS_FEED_PARAMS_TYPE,
      viewerDid,
      ...params,
    },
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  }
}

const sourceRow = (
  overrides: Partial<InternalSourceFeedRow> = {},
): InternalSourceFeedRow => ({
  uri: activityUri,
  cid,
  actorDid: authorDid,
  collection: 'org.hypercerts.claim.activity',
  kind: 'cert.create',
  sortValue: '2026-07-20T00:00:03.000000Z',
  sourceValue: {
    $type: 'org.hypercerts.claim.activity',
    title: 'Restore the watershed',
    shortDescription: 'Native forest restoration',
    createdAt,
  },
  ...overrides,
})

class FakePages implements FeedPageLoader {
  readonly calls: {
    readonly input: GetFeedSkeletonInput
    readonly mode: FeedPageMode
  }[] = []

  constructor(
    private readonly page: InternalFeedPage<InternalSourceFeedRow>,
    private readonly failure?: Error,
  ) {}

  loadPage(
    input: GetFeedSkeletonInput,
    mode: 'metadata',
  ): Promise<InternalFeedPage<InternalFeedRow>>
  loadPage(
    input: GetFeedSkeletonInput,
    mode: 'with-source',
  ): Promise<InternalFeedPage<InternalSourceFeedRow>>
  async loadPage(
    input: GetFeedSkeletonInput,
    mode: FeedPageMode,
  ): Promise<
    InternalFeedPage<InternalFeedRow> | InternalFeedPage<InternalSourceFeedRow>
  > {
    this.calls.push({ input, mode })
    if (this.failure) throw this.failure
    if (mode !== 'with-source') {
      throw new Error(
        'This hydrated-service fake supports source-aware pages only.',
      )
    }
    return this.page
  }
}

class FakeIdentities implements IdentityReader {
  readonly calls: string[][] = []

  constructor(
    private readonly contexts: ReadonlyMap<string, ActorContext>,
    private readonly failure?: Error,
  ) {}

  async getByDids(
    dids: readonly string[],
  ): Promise<ReadonlyMap<string, ActorContext>> {
    this.calls.push([...dids])
    if (this.failure) throw this.failure
    return this.contexts
  }
}

const allContexts = (): ReadonlyMap<string, ActorContext> =>
  new Map([
    [
      authorDid,
      {
        did: authorDid,
        certifiedProfile: {
          $type: 'app.certified.actor.profile',
          displayName: 'Certified Author',
          createdAt,
        },
      },
    ],
    [endorsedDid, { did: endorsedDid }],
  ])

const populatedPage = (): InternalFeedPage<InternalSourceFeedRow> => ({
  rows: [
    sourceRow(),
    sourceRow({
      uri: invalidUri,
      actorDid: invalidAuthorDid,
      collection: 'org.hypercerts.collection',
      kind: 'collection.create',
      sortValue: '2026-07-20T00:00:02.000000Z',
      sourceValue: {
        $type: 'org.hypercerts.collection',
        createdAt,
      },
    }),
    sourceRow({
      uri: endorsementUri,
      collection: 'app.certified.badge.award',
      kind: 'endorsement.award',
      sortValue: '2026-07-20T00:00:01.000000Z',
      sourceValue: {
        $type: 'app.certified.badge.award',
        badge: {
          $type: 'com.atproto.repo.strongRef',
          uri: `at://${authorDid}/app.certified.badge.definition/endorsement`,
          cid: definitionCid,
        },
        subject: {
          $type: 'app.certified.defs#did',
          did: endorsedDid,
        },
        createdAt,
      },
    }),
  ],
  cursor,
})

describe('HydratedFeedService', () => {
  it('loads once, drops invalid sources, batches valid identities once, and preserves order and cursor', async () => {
    const pages = new FakePages(populatedPage())
    const identities = new FakeIdentities(allContexts())
    const service = new HydratedFeedService(pages, identities)
    const input = feedRequest({ limit: 3 })

    const output = await service.getFeed(input)

    expect(pages.calls).toEqual([{ input, mode: 'with-source' }])
    expect(identities.calls).toEqual([[authorDid, endorsedDid]])
    expect(output.cursor).toBe(cursor)
    expect(output.feed.map((item) => item.subject)).toEqual([
      activityUri,
      endorsementUri,
    ])
    expect(output.feed[0]).toEqual({
      subject: activityUri,
      view: {
        $type: 'org.hypercerts.feed.defs#hypercertsFeedView',
        kind: 'cert.create',
        actor: {
          did: authorDid,
          displayName: 'Certified Author',
        },
        content: {
          $type: 'org.hypercerts.feed.defs#activityView',
          title: 'Restore the watershed',
          shortDescription: 'Native forest restoration',
          createdAt,
          locationCount: 0,
        },
      },
    })
    expect(output.feed[1]).toMatchObject({
      subject: endorsementUri,
      view: {
        $type: 'org.hypercerts.feed.defs#hypercertsFeedView',
        actor: { did: authorDid },
        content: {
          $type: 'org.hypercerts.feed.defs#endorsementView',
          subject: { did: endorsedDid },
        },
      },
    })

    for (const item of output.feed) {
      expect(item).not.toHaveProperty('$type')
      expect(item).not.toHaveProperty('id')
      expect(item).not.toHaveProperty('feedTimestamp')
      expect(item).not.toHaveProperty('record')
      expect(item).not.toHaveProperty('recordState')
      expect(item).not.toHaveProperty('actorDid')
      expect(item.view.actor).not.toHaveProperty('profileSource')
    }
  })

  it('returns target references without discovering or reading target identities', async () => {
    const authorContext = allContexts().get(authorDid)
    if (authorContext === undefined) throw new Error('missing author fixture')
    const pages = new FakePages({
      rows: [
        sourceRow({
          uri: measurementUri,
          collection: 'org.hypercerts.context.measurement',
          kind: 'measurement.create',
          sourceValue: {
            $type: 'org.hypercerts.context.measurement',
            metric: 'hectares restored',
            unit: 'ha',
            value: '42',
            subjects: [
              {
                $type: 'com.atproto.repo.strongRef',
                uri: targetUri,
                cid,
              },
            ],
            createdAt,
          },
        }),
      ],
    })
    const identities = new FakeIdentities(new Map([[authorDid, authorContext]]))
    const service = new HydratedFeedService(pages, identities)

    const output = await service.getFeed(feedRequest())

    expect(identities.calls).toEqual([[authorDid]])
    expect(output.feed[0]).toMatchObject({
      view: {
        content: {
          $type: 'org.hypercerts.feed.defs#measurementView',
          target: { uri: targetUri, cid },
        },
      },
    })
  })

  it('drops an entirely invalid selected page, skips identities, and preserves its cursor bytes', async () => {
    const pages = new FakePages({
      rows: [
        sourceRow({
          uri: invalidUri,
          actorDid: invalidAuthorDid,
          collection: 'org.hypercerts.collection',
          kind: 'collection.create',
          sourceValue: {
            $type: 'org.hypercerts.collection',
            createdAt,
          },
        }),
      ],
      cursor,
    })
    const identities = new FakeIdentities(new Map())
    const service = new HydratedFeedService(pages, identities)

    await expect(service.getFeed(feedRequest())).resolves.toEqual({
      feed: [],
      cursor,
    })
    expect(identities.calls).toEqual([])
  })

  it('skips identity retrieval for an empty page and preserves its cursor bytes', async () => {
    const pages = new FakePages({ rows: [], cursor })
    const identities = new FakeIdentities(new Map())
    const service = new HydratedFeedService(pages, identities)

    await expect(service.getFeed(feedRequest())).resolves.toEqual({
      feed: [],
      cursor,
    })
    expect(pages.calls).toHaveLength(1)
    expect(identities.calls).toEqual([])
  })

  it.each([
    ['missing', new Map<string, ActorContext>()],
    [
      'mismatched',
      new Map<string, ActorContext>([[authorDid, { did: invalidAuthorDid }]]),
    ],
  ])('rejects a %s requested identity context', async (_label, contexts) => {
    const service = new HydratedFeedService(
      new FakePages({ rows: [sourceRow()] }),
      new FakeIdentities(contexts),
    )

    await expect(service.getFeed(feedRequest())).rejects.toThrow(
      /hydrated feed identity invariant failed.*requested DID/i,
    )
  })

  it('propagates page and identity read failures', async () => {
    const pageFailure = new Error('page query failed')
    const identityFailure = new Error('identity query failed')

    await expect(
      new HydratedFeedService(
        new FakePages({ rows: [] }, pageFailure),
        new FakeIdentities(new Map()),
      ).getFeed(feedRequest()),
    ).rejects.toBe(pageFailure)

    await expect(
      new HydratedFeedService(
        new FakePages({ rows: [sourceRow()] }),
        new FakeIdentities(new Map(), identityFailure),
      ).getFeed(feedRequest()),
    ).rejects.toBe(identityFailure)
  })
})
