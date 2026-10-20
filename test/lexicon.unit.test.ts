import { readFileSync } from 'node:fs'

import { jsonToLex } from '@atproto/lex'
import { describe, expect, it } from 'vitest'

import { FeedErrorCode } from '../src/feed/errors.js'
import {
  $input as hydratedInput,
  $output as hydratedOutput,
} from '../src/lexicons/org/hypercerts/feed/getFeed.js'
import {
  $input as skeletonInput,
  $output as skeletonOutput,
} from '../src/lexicons/org/hypercerts/feed/getFeedSkeleton.js'

const readLexicon = (relativePath: string): Record<string, any> =>
  JSON.parse(
    readFileSync(new URL(`../lexicons/${relativePath}`, import.meta.url), 'utf8'),
  ) as Record<string, any>

const skeletonLexicon = readLexicon(
  'org/hypercerts/feed/getFeedSkeleton.json',
)
const hydratedLexicon = readLexicon('org/hypercerts/feed/getFeed.json')
const defsLexicon = readLexicon('org/hypercerts/feed/defs.json')

const skeletonMain = skeletonLexicon.defs.main
const hydratedMain = hydratedLexicon.defs.main
const defs = defsLexicon.defs

const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const uri = `at://${actorDid}/org.hypercerts.claim.activity/3kpn`
const targetUri = `at://${viewerDid}/org.hypercerts.claim.activity/target`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const blobCid = 'bafkreiehxpuhtr5f6v4eu4byjo2j7kkrhjvd7psmfu4imnpdzb3bdqb7vy'
const createdAt = '2026-07-21T10:00:00.000Z'
const feedId = 'org.hypercerts.feed.defs#hypercertsFeed'
const paramsType = 'org.hypercerts.feed.defs#hypercertsFeedParams'
const supportedFeedKinds = [
  'cert.create',
  'collection.create',
  'project.created_with_cert',
  'evaluation.create',
  'measurement.create',
  'update.create',
  'endorsement.award',
] as const

const feedRequest = {
  feedId,
  params: { $type: paramsType, viewerDid },
  limit: 20,
  cursor: 'next-page',
}

const uriImage = {
  $type: 'org.hypercerts.defs#uri',
  uri: 'https://example.com/image.png',
}
const blob = jsonToLex(
  {
    $type: 'blob',
    ref: { $link: blobCid },
    mimeType: 'image/png',
    size: 128,
  },
  { strict: true },
)
const blobWith = (
  overrides: Record<string, unknown>,
): Record<string, unknown> => ({
  ...(blob as Record<string, unknown>),
  ...overrides,
})
const smallImage = {
  $type: 'org.hypercerts.defs#smallImage',
  image: blob,
}
const largeImage = {
  $type: 'org.hypercerts.defs#largeImage',
  image: blob,
}
const smallBlob = {
  $type: 'org.hypercerts.defs#smallBlob',
  blob,
}
const actor = {
  did: actorDid,
  displayName: 'Actor',
  avatar: smallImage,
}
const target = { uri: targetUri, cid }

const viewsByKind = {
  'cert.create': {
    $type: 'org.hypercerts.feed.defs#activityView',
    title: 'Restore the watershed',
    image: uriImage,
    createdAt,
    locationCount: 2,
  },
  'collection.create': {
    $type: 'org.hypercerts.feed.defs#collectionView',
    title: 'Watershed projects',
    image: largeImage,
    createdAt,
    itemCount: 3,
  },
  'project.created_with_cert': {
    $type: 'org.hypercerts.feed.defs#collectionView',
    title: 'Watershed project',
    createdAt,
    itemCount: 1,
  },
  'endorsement.award': {
    $type: 'org.hypercerts.feed.defs#endorsementView',
    subject: { did: viewerDid },
    createdAt,
  },
  'evaluation.create': {
    $type: 'org.hypercerts.feed.defs#evaluationView',
    summary: 'Strong evidence',
    createdAt,
    target,
  },
  'measurement.create': {
    $type: 'org.hypercerts.feed.defs#measurementView',
    metric: 'hectares restored',
    createdAt,
    target,
  },
  'update.create': {
    $type: 'org.hypercerts.feed.defs#updateView',
    title: 'Field report',
    image: smallBlob,
    createdAt,
    target,
  },
} as const

const feedItem = (
  kind: keyof typeof viewsByKind = 'cert.create',
): Record<string, any> => ({
  subject: uri,
  view: {
    $type: 'org.hypercerts.feed.defs#hypercertsFeedView',
    kind,
    actor,
    content: viewsByKind[kind],
  },
})

const withFeedView = (
  item: Record<string, any>,
  overrides: Record<string, unknown>,
): Record<string, any> => ({
  ...item,
  view: { ...item.view, ...overrides },
})

const withContent = (
  item: Record<string, any>,
  content: Record<string, unknown>,
): Record<string, any> => withFeedView(item, { content })

describe('feed Lexicon contract', () => {
  it('keeps registered feed inputs and UpperCamelCase public errors identical', () => {
    expect(hydratedMain.input).toEqual(skeletonMain.input)
    expect(hydratedMain.input.schema.required).toEqual(['feedId'])
    expect(hydratedMain.input.schema.properties.feedId).toMatchObject({
      type: 'string',
      knownValues: [feedId],
    })
    expect(
      defs.hypercertsFeedParams.properties.kinds.items.knownValues,
    ).toEqual(supportedFeedKinds)
    expect(defs.hypercertsFeedView.properties.kind.knownValues).toEqual(
      supportedFeedKinds,
    )
    expect(hydratedMain.input.schema.properties.params).toMatchObject({
      type: 'union',
      closed: false,
      refs: [paramsType],
    })
    expect(defs.hypercertsFeedParams.required ?? []).not.toContain('viewerDid')
    expect(hydratedMain.input.schema.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 100,
    })
    expect(hydratedMain.input.schema.properties.cursor).toMatchObject({
      type: 'string',
      maxLength: 4096,
    })
    expect(defs.hypercertsFeedParams.properties).not.toHaveProperty('authors')
    expect(defs.hypercertsFeedParams.properties).not.toHaveProperty('limit')
    expect(defs.hypercertsFeedParams.properties).not.toHaveProperty('cursor')
    expect(defs.hypercertsFeedParams.properties.organizationQuality.ref).toBe(
      'org.hypercerts.feed.defs#organizationQualityPolicy',
    )
    expect(hydratedMain.errors).toEqual(skeletonMain.errors)
    const errorNames = hydratedMain.errors.map(
      (error: { name: string }) => error.name,
    )
    expect(errorNames).toEqual([
      'InvalidRequest',
      'UnsupportedFeed',
      'InvalidCursor',
      'InternalError',
    ])
    expect(errorNames).toEqual(Object.values(FeedErrorCode))

    for (const parser of [skeletonInput, hydratedInput]) {
      expect(() => parser.schema.$parse(feedRequest)).not.toThrow()
      expect(() =>
        parser.schema.$parse({
          feedId: 'app.example.feed.defs#futureFeed',
          limit: 100,
          cursor: 'future-page',
        }),
      ).not.toThrow()
      expect(() =>
        parser.schema.$parse({
          feedId: 'app.example.feed.defs#futureFeed',
          params: {
            $type: 'app.example.feed.defs#futureParams',
            future: true,
          },
        }),
      ).not.toThrow()
    }
  })

  it('defines the generic URI-only skeleton wire shape', () => {
    expect(skeletonMain.output.schema.required).toEqual(['feed'])
    expect(skeletonMain.output.schema.properties.cursor).toMatchObject({
      type: 'string',
      maxLength: 4096,
    })
    expect(skeletonLexicon.defs.feedSkeletonItem.required).toEqual(['subject'])
    expect(skeletonLexicon.defs.feedSkeletonItem.properties).toEqual({
      subject: {
        type: 'string',
        format: 'at-uri',
        description: 'AT-URI of the record to hydrate.',
      },
    })
    expect(defs).toHaveProperty('organizationQualityPolicy')
    expect(skeletonLexicon.defs).not.toHaveProperty(
      'organizationQualityPolicy',
    )
    expect(defs).not.toHaveProperty('feedSkeletonItem')

    expect(() =>
      skeletonInput.schema.$parse({
        feedId,
        params: {
          $type: paramsType,
          viewerDid,
          organizationQuality: {
            allowed: ['high-quality'],
            includeUnrated: false,
          },
        },
      }),
    ).not.toThrow()
    expect(() =>
      skeletonInput.schema.$parse({
        feedId,
        params: { $type: paramsType },
      }),
    ).not.toThrow()
    expect(() =>
      skeletonOutput.schema.$parse({ feed: [{ subject: uri }] }),
    ).not.toThrow()
  })

  it('keeps every union in the public feed Lexicons open', () => {
    for (const lexicon of [skeletonLexicon, hydratedLexicon, defsLexicon]) {
      expect(JSON.stringify(lexicon)).not.toContain('"closed":true')
    }
  })

  it('defines a generic hydrated item with a required open feed view', () => {
    expect(hydratedMain.output.schema.required).toEqual(['feed'])
    expect(hydratedMain.output.schema.properties.feed.items).toEqual({
      type: 'ref',
      ref: '#feedItem',
    })
    expect(hydratedLexicon.defs.feedItem.required).toEqual(['subject', 'view'])
    expect(hydratedLexicon.defs.feedItem.properties.subject).toMatchObject({
      type: 'string',
      format: 'at-uri',
    })
    expect(hydratedLexicon.defs.feedItem.properties.view).toMatchObject({
      type: 'union',
      closed: false,
      refs: ['org.hypercerts.feed.defs#hypercertsFeedView'],
    })
    expect(defs.hypercertsFeedView.required).toEqual([
      'kind',
      'actor',
      'content',
    ])
    expect(defs.hypercertsFeedView.properties.content).toMatchObject({
      type: 'union',
      closed: false,
      refs: [
        '#activityView',
        '#collectionView',
        '#endorsementView',
        '#evaluationView',
        '#measurementView',
        '#updateView',
      ],
    })
    expect(defs).not.toHaveProperty('feedItem')

    const serialized = JSON.stringify({
      feedItem: hydratedLexicon.defs.feedItem,
      hypercertsFeedView: defs.hypercertsFeedView,
    })
    for (const forbidden of [
      'record',
      'recordState',
      'profileSource',
      'actorDid',
      'feedTimestamp',
      'notFound',
      'cidMismatch',
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`)
    }
  })

  it('keeps activity and collection counts optional on the wire', () => {
    expect(defs.activityView.required).toEqual(['title'])
    expect(defs.collectionView.required).toEqual(['title'])
    expect(defs.activityView.properties.locationCount).toEqual({
      type: 'integer',
      minimum: 0,
    })
    expect(defs.collectionView.properties.itemCount).toEqual({
      type: 'integer',
      minimum: 0,
    })

    const activityWithoutCount: Record<string, unknown> = {
      ...viewsByKind['cert.create'],
    }
    const collectionWithoutCount: Record<string, unknown> = {
      ...viewsByKind['collection.create'],
    }
    delete activityWithoutCount.locationCount
    delete collectionWithoutCount.itemCount

    expect(() =>
      hydratedOutput.schema.$parse({
        feed: [
          withContent(feedItem('cert.create'), activityWithoutCount),
          withContent(feedItem('collection.create'), collectionWithoutCount),
        ],
      }),
    ).not.toThrow()
  })

  it('uses protocol-native Hypercerts variants through open image unions', () => {
    expect(defs).not.toHaveProperty('uriImage')
    expect(defs).not.toHaveProperty('blobImage')
    expect(Object.keys(defs.actorSummary.properties).sort()).toEqual([
      'avatar',
      'did',
      'displayName',
    ])
    expect(defs.actorSummary.properties.avatar).toEqual({
      type: 'union',
      refs: [
        'org.hypercerts.defs#uri',
        'org.hypercerts.defs#smallImage',
      ],
    })
    expect(defs.activityView.properties.image).toEqual(
      defs.actorSummary.properties.avatar,
    )
    expect(defs.collectionView.properties.image).toEqual({
      type: 'union',
      refs: [
        'org.hypercerts.defs#uri',
        'org.hypercerts.defs#smallImage',
        'org.hypercerts.defs#largeImage',
      ],
    })
    expect(defs.updateView.properties.image).toEqual({
      type: 'union',
      refs: [
        'org.hypercerts.defs#uri',
        'org.hypercerts.defs#smallBlob',
      ],
    })
  })

  it('uses strong-reference targets only on evaluation, measurement, and update views', () => {
    for (const name of ['evaluationView', 'measurementView', 'updateView']) {
      expect(defs[name].properties.target).toEqual({
        type: 'ref',
        ref: 'com.atproto.repo.strongRef',
      })
    }
  })

  it('accepts both image variants and all six views across seven kinds', () => {
    const items = Object.keys(viewsByKind).map((kind) =>
      feedItem(kind as keyof typeof viewsByKind),
    )

    expect(() =>
      hydratedOutput.schema.$parse({ feed: items, cursor: 'opaque-cursor' }),
    ).not.toThrow()
  })

  it('accepts unknown future image and view variants through open unions', () => {
    const unknownImage = {
      $type: 'example.feed#unknownImage',
      uri: 'https://example.com/future-image.png',
    }
    expect(() =>
      hydratedOutput.schema.$parse({
        feed: [
          withFeedView(feedItem(), {
            actor: { did: actorDid, avatar: unknownImage },
          }),
          withContent(feedItem(), {
            ...viewsByKind['cert.create'],
            image: unknownImage,
          }),
          withContent(feedItem(), {
            $type: 'example.feed#unknownContent',
          }),
          {
            ...feedItem(),
            view: { $type: 'example.feed#unknownFeedView' },
          },
        ],
      }),
    ).not.toThrow()
  })

  it.each([
    [
      'missing view discriminator',
      { ...feedItem(), view: { kind: 'cert.create', actor, content: {} } },
    ],
    [
      'missing required view',
      (() => {
        const item = feedItem()
        delete item.view
        return item
      })(),
    ],
    [
      'missing image discriminator',
      withFeedView(feedItem(), {
        actor: {
          did: actorDid,
          avatar: { uri: 'https://example.com/image.png' },
        },
      }),
    ],
    [
      'malformed actor DID',
      withFeedView(feedItem(), { actor: { did: 'not-a-did' } }),
    ],
    [
      'malformed blob CID',
      withFeedView(feedItem(), {
        actor: {
          did: actorDid,
          avatar: {
            $type: 'org.hypercerts.defs#smallImage',
            image: blobWith({ ref: 'not-a-cid' }),
          },
        },
      }),
    ],
    [
      'malformed image URI',
      withFeedView(feedItem(), {
        actor: {
          did: actorDid,
          avatar: { ...uriImage, uri: 'not a URI' },
        },
      }),
    ],
    [
      'negative image size',
      withFeedView(feedItem(), {
        actor: {
          did: actorDid,
          avatar: {
            $type: 'org.hypercerts.defs#smallImage',
            image: blobWith({ size: -1 }),
          },
        },
      }),
    ],
    [
      'malformed target reference',
      withContent(feedItem('evaluation.create'), {
        ...viewsByKind['evaluation.create'],
        target: { uri: 'not-an-at-uri', cid: 'not-a-cid' },
      }),
    ],
  ])('rejects %s', (_label, item) => {
    expect(() => hydratedOutput.schema.$parse({ feed: [item] })).toThrow()
  })
})
