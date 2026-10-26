import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { FeedErrorCode } from '../src/feed/errors.js'
import { MAX_GROUP_ROWS } from '../src/feed/types.js'
import {
  $input as feedInput,
  $output as feedOutput,
} from '../src/lexicons/app/gainforest/feed/getFeed.js'
import {
  $input as skeletonInput,
  $output as skeletonOutput,
} from '../src/lexicons/app/gainforest/feed/getFeedSkeleton.js'

type JsonObject = Record<string, unknown>

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asJsonObject = (value: unknown): JsonObject => {
  if (!isJsonObject(value)) throw new Error('Expected a Lexicon JSON object')
  return value
}

const valueAt = (root: JsonObject, ...path: string[]): unknown => {
  let value: unknown = root
  for (const key of path) {
    value = asJsonObject(value)[key]
  }
  return value
}

const objectAt = (root: JsonObject, ...path: string[]): JsonObject =>
  asJsonObject(valueAt(root, ...path))

const readLexicon = (relativePath: string): JsonObject => {
  const source = readFileSync(
    new URL(`../lexicons/${relativePath}`, import.meta.url),
    'utf8',
  )
  return asJsonObject(JSON.parse(source))
}

const skeletonLexicon = readLexicon('app/gainforest/feed/getFeedSkeleton.json')
const feedLexicon = readLexicon('app/gainforest/feed/getFeed.json')
const defsLexicon = readLexicon('app/gainforest/feed/defs.json')

const skeletonMain = objectAt(skeletonLexicon, 'defs', 'main')
const feedMain = objectAt(feedLexicon, 'defs', 'main')
const defs = objectAt(defsLexicon, 'defs')

const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const at = (collection: string, rkey: string): string =>
  `at://${actorDid}/${collection}/${rkey}`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const createdAt = '2026-07-21T10:00:00.000Z'
const feedId = 'app.gainforest.feed.defs#activityFeed'
const paramsType = 'app.gainforest.feed.defs#activityFeedParams'

const feedRequest = {
  feedId,
  params: { $type: paramsType, viewerDid, filter: 'post', following: true },
  limit: 20,
  cursor: 'next-page',
}

const recordItem = {
  $type: 'app.gainforest.feed.defs#recordItem',
  kind: 'project',
  uri: at('org.hypercerts.collection', 'c1'),
  cid,
  did: actorDid,
  createdAt,
}
const repostItem = {
  $type: 'app.gainforest.feed.defs#repostItem',
  uri: at('app.gainforest.feed.repost', 'r1'),
  cid,
  did: actorDid,
  createdAt,
  subject: at('app.gainforest.feed.post', 'p1'),
}
const groupKey = 'AAAAAAAAAAAAAAAAAAAAAA'
const burstItem = {
  $type: 'app.gainforest.feed.defs#burstItem',
  did: actorDid,
  total: MAX_GROUP_ROWS,
  from: '2026-07-21T09:00:00.000Z',
  to: createdAt,
  subjects: [at('app.gainforest.dwc.occurrence', 'o1')],
  groupKey,
  continued: false,
  capped: true,
}
const audioItem = {
  $type: 'app.gainforest.feed.defs#audioItem',
  did: actorDid,
  deployment: at('app.gainforest.ac.deployment', 'folder'),
  total: 40,
  from: '2026-07-21T09:00:00.000Z',
  to: createdAt,
  subjects: [at('app.gainforest.ac.audio', 'a1')],
  groupKey,
  continued: true,
  capped: false,
}

const parseFeed = (feed: unknown[]) => feedOutput.schema.$parse({ feed })

describe('feed Lexicon contract', () => {
  it('keeps both procedures on the same input, errors, and request wrapper', () => {
    for (const field of ['feedId', 'params', 'cursor']) {
      expect(valueAt(feedMain, 'input', 'schema', 'properties', field)).toEqual(
        valueAt(skeletonMain, 'input', 'schema', 'properties', field),
      )
    }
    for (const main of [feedMain, skeletonMain]) {
      expect(
        valueAt(main, 'input', 'schema', 'properties', 'limit'),
      ).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 })
    }
    expect(valueAt(feedMain, 'errors')).toEqual(valueAt(skeletonMain, 'errors'))
    expect(valueAt(feedMain, 'input', 'schema', 'required')).toEqual(['feedId'])
    expect(
      valueAt(feedMain, 'input', 'schema', 'properties', 'feedId'),
    ).toMatchObject({ type: 'string', knownValues: [feedId] })
    expect(
      valueAt(feedMain, 'input', 'schema', 'properties', 'params'),
    ).toMatchObject({ type: 'union', closed: false, refs: [paramsType] })

    const errors = valueAt(feedMain, 'errors')
    expect(errors).toEqual(
      Object.values(FeedErrorCode).map(
        (name) => expect.objectContaining({ name }) as unknown,
      ),
    )

    for (const parser of [skeletonInput, feedInput]) {
      expect(() => parser.schema.$parse(feedRequest)).not.toThrow()
      expect(() =>
        parser.schema.$parse({
          feedId: 'app.example.feed.defs#futureFeed',
          params: { $type: 'app.example.feed.defs#futureParams', future: true },
        }),
      ).not.toThrow()
    }
  })

  it('defines the activity feed parameters without pagination or author overrides', () => {
    const properties = objectAt(defs, 'activityFeedParams', 'properties')

    expect(Object.keys(properties).sort()).toEqual([
      'filter',
      'following',
      'viewerDid',
    ])
    expect(valueAt(properties, 'filter', 'knownValues')).toEqual([
      'all',
      'project',
      'observation',
      'organization',
      'post',
      'audio',
    ])
    expect(valueAt(defs, 'activityFeedParams', 'required')).toBeUndefined()
    for (const main of [feedMain, skeletonMain]) {
      expect(
        valueAt(main, 'input', 'schema', 'properties', 'params', 'description'),
      ).toContain('Optional for app.gainforest.feed.defs#activityFeed')
      expect(valueAt(main, 'description')).toContain(
        'Omitting params selects the global feed.',
      )
    }
    expect(valueAt(defs, 'activityFeedParams', 'description')).toContain(
      'omits params gets the defaults',
    )

    const parsed = feedInput.schema.$parse({
      feedId,
      params: { $type: paramsType },
    })
    expect(parsed.params).toMatchObject({ filter: 'all', following: false })
  })

  it('defines the skeleton as URI-only subjects', () => {
    expect(
      valueAt(skeletonLexicon, 'defs', 'feedSkeletonItem', 'required'),
    ).toEqual(['subject'])
    expect(
      Object.keys(
        objectAt(skeletonLexicon, 'defs', 'feedSkeletonItem', 'properties'),
      ),
    ).toEqual(['subject'])
    expect(() =>
      skeletonOutput.schema.$parse({
        feed: [{ subject: at('app.gainforest.feed.post', 'p1') }],
        cursor: 'next',
      }),
    ).not.toThrow()
    expect(() =>
      skeletonOutput.schema.$parse({ feed: [{ subject: 'not-an-at-uri' }] }),
    ).toThrow()
  })

  it('states plainly that getFeed returns references and metadata, not records', () => {
    for (const description of [
      valueAt(feedMain, 'description'),
      valueAt(defsLexicon, 'description'),
    ]) {
      expect(description).toEqual(
        expect.stringMatching(/references and selection metadata/) as unknown,
      )
      expect(description).toEqual(expect.stringMatching(/hydrate/) as unknown)
    }
    expect(valueAt(feedMain, 'description')).toContain(
      'It does not contain record content.',
    )
  })

  it('keeps every union in the public feed Lexicons open', () => {
    for (const lexicon of [skeletonLexicon, feedLexicon, defsLexicon]) {
      expect(JSON.stringify(lexicon)).not.toContain('"closed":true')
    }
    expect(
      valueAt(feedMain, 'output', 'schema', 'properties', 'feed', 'items'),
    ).toMatchObject({
      type: 'union',
      closed: false,
      refs: [
        'app.gainforest.feed.defs#recordItem',
        'app.gainforest.feed.defs#repostItem',
        'app.gainforest.feed.defs#burstItem',
        'app.gainforest.feed.defs#audioItem',
      ],
    })
  })

  it('adds no display fields to any feed item', () => {
    const displayFields = [
      'title',
      'text',
      'image',
      'avatar',
      'displayName',
      'handle',
      'description',
    ]
    for (const name of ['recordItem', 'repostItem', 'burstItem', 'audioItem']) {
      const properties = Object.keys(objectAt(defs, name, 'properties'))
      for (const field of displayFields) {
        expect(properties).not.toContain(field)
      }
    }
  })

  it('accepts every item variant and the cursor', () => {
    const parsed = feedOutput.schema.$parse({
      feed: [recordItem, repostItem, burstItem, audioItem],
      cursor: 'next',
    })

    expect(parsed.feed).toHaveLength(4)
    expect(parsed.cursor).toBe('next')
  })

  it('caps burst and audio items at the same number of rows as the service', () => {
    for (const name of ['burstItem', 'audioItem']) {
      expect(valueAt(defs, name, 'properties', 'total', 'maximum')).toBe(
        MAX_GROUP_ROWS,
      )
    }
  })

  it.each([
    ['a burst', burstItem],
    ['an audio item', audioItem],
  ])(
    'applies false to the continued and capped flags of %s that omits them',
    (_name, item) => {
      const { continued: _continued, capped: _capped, ...withoutFlags } = item

      expect(parseFeed([withoutFlags]).feed[0]).toMatchObject({
        continued: false,
        capped: false,
      })
    },
  )

  it('accepts a one-row continuation chunk of a burst', () => {
    expect(() =>
      parseFeed([{ ...burstItem, total: 1, continued: true, capped: false }]),
    ).not.toThrow()
  })

  it('accepts record and repost items without a cid', () => {
    const { cid: _recordCid, ...recordWithoutCid } = recordItem
    const { cid: _repostCid, ...repostWithoutCid } = repostItem

    expect(() => parseFeed([recordWithoutCid, repostWithoutCid])).not.toThrow()
  })

  it('accepts an audio group without a recorder folder', () => {
    const { deployment: _deployment, ...withoutFolder } = audioItem

    expect(() => parseFeed([withoutFolder])).not.toThrow()
  })

  it('accepts unknown future item variants and unknown record kinds', () => {
    expect(() =>
      parseFeed([
        { $type: 'app.example.feed.defs#futureItem', future: true },
        { ...recordItem, kind: 'futureKind' },
      ]),
    ).not.toThrow()
  })

  it.each([
    ['a record URI that is not an AT-URI', { ...recordItem, uri: 'nope' }],
    ['a record with a malformed cid', { ...recordItem, cid: 'not-a-cid' }],
    ['a record owned by a non-DID', { ...recordItem, did: 'alice.test' }],
    ['a repost without its subject', { ...repostItem, subject: undefined }],
    ['a burst of no observations', { ...burstItem, total: 0 }],
    [
      'a burst larger than the cap',
      { ...burstItem, total: MAX_GROUP_ROWS + 1 },
    ],
    ['a burst without a group key', { ...burstItem, groupKey: undefined }],
    ['a burst with an empty group key', { ...burstItem, groupKey: '' }],
    [
      'a burst with a group key that is too long',
      { ...burstItem, groupKey: 'A'.repeat(65) },
    ],
    [
      'a burst with more than 20 samples',
      {
        ...burstItem,
        subjects: Array.from({ length: 21 }, (_, index) =>
          at('app.gainforest.dwc.occurrence', `o${String(index)}`),
        ),
      },
    ],
    ['a burst without a time range', { ...burstItem, from: undefined }],
    ['an audio item with no recordings', { ...audioItem, total: 0 }],
    [
      'an audio item larger than the cap',
      { ...audioItem, total: MAX_GROUP_ROWS + 1 },
    ],
    ['an audio item without its newest time', { ...audioItem, to: undefined }],
    [
      'an audio item without its oldest time',
      { ...audioItem, from: undefined },
    ],
    [
      'an audio item without a group key',
      { ...audioItem, groupKey: undefined },
    ],
    ['an audio item with an empty group key', { ...audioItem, groupKey: '' }],
  ])('rejects %s', (_name, item) => {
    expect(() => parseFeed([item])).toThrow()
  })
})
