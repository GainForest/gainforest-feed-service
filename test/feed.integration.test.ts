import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import pino from 'pino'

import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { Database } from '../src/database.js'
import { createActivityFeed } from '../src/feed/query.js'
import { FeedRegistry } from '../src/feed/registry.js'
import { FeedService } from '../src/feed/service.js'
import {
  ACTIVITY_FEED_ID,
  ACTIVITY_FEED_PARAMS_TYPE,
  type ActivityFeedItem,
  type FeedRequest,
  type GetFeedOutput,
} from '../src/feed/types.js'
import { $output } from '../src/lexicons/app/gainforest/feed/getFeed.js'
import { Metrics } from '../src/metrics.js'
import { modelFeed, type ModelItem } from './support/feed-model.js'
import {
  RecordFixture,
  cid,
  randomDid,
  uriOf,
  type SeedRecord,
} from './support/hyperindex-fixture.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
if (TEST_DATABASE_URL === undefined || TEST_DATABASE_URL.length === 0) {
  throw new Error(
    'TEST_DATABASE_URL is required for integration tests; point it at an empty disposable Postgres 16+ database.',
  )
}

const BASE = Date.parse('2026-03-01T00:00:00.000Z')
/** An ISO timestamp the given number of minutes after the fixture epoch. */
const minute = (minutes: number): string =>
  new Date(BASE + minutes * 60_000).toISOString()
const second = (seconds: number): string =>
  new Date(BASE + seconds * 1_000).toISOString()

const OBSERVATION = 'app.gainforest.dwc.occurrence'
const POST = 'app.gainforest.feed.post'
const REPOST = 'app.gainforest.feed.repost'
const PROJECT = 'org.hypercerts.collection'
const ORGANIZATION = 'app.certified.actor.organization'
const AUDIO = 'app.gainforest.ac.audio'
const FOLLOW = 'app.certified.graph.follow'
const RECEIPT = 'org.hypercerts.funding.receipt'

const observation = (
  did: string,
  rkey: string,
  createdAt: string | null,
  json: Record<string, unknown> = {},
): SeedRecord => ({ did, collection: OBSERVATION, rkey, createdAt, json })

const post = (
  did: string,
  rkey: string,
  createdAt: string | null,
  json: Record<string, unknown> = {},
): SeedRecord => ({ did, collection: POST, rkey, createdAt, json })

const project = (
  did: string,
  rkey: string,
  createdAt: string,
  type = 'project',
): SeedRecord => ({
  did,
  collection: PROJECT,
  rkey,
  createdAt,
  json: { type },
})

const organization = (did: string, createdAt: string): SeedRecord => ({
  did,
  collection: ORGANIZATION,
  rkey: 'self',
  createdAt,
})

const repost = (
  did: string,
  rkey: string,
  createdAt: string,
  subject: SeedRecord,
): SeedRecord => ({
  did,
  collection: REPOST,
  rkey,
  createdAt,
  json: { subject: { uri: uriOf(subject), cid } },
})

const audio = (
  did: string,
  rkey: string,
  createdAt: string,
  deployment?: string,
): SeedRecord => ({
  did,
  collection: AUDIO,
  rkey,
  createdAt,
  json: deployment === undefined ? {} : { deploymentRef: deployment },
})

const follow = (viewer: string, subject: string): SeedRecord => ({
  did: viewer,
  collection: FOLLOW,
  rkey: `follow-${subject.slice(-8)}`,
  createdAt: minute(0),
  json: { subject },
})

const rkeyOf = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1)

/** A compact, comparable form of a service item. */
const modelOf = (item: ActivityFeedItem): ModelItem => {
  switch (item.$type) {
    case 'app.gainforest.feed.defs#recordItem':
      return {
        type: 'record',
        kind: item.kind,
        uri: item.uri,
        did: item.did,
        at: Date.parse(item.createdAt),
      }
    case 'app.gainforest.feed.defs#repostItem':
      return {
        type: 'repost',
        uri: item.uri,
        did: item.did,
        subject: item.subject,
        at: Date.parse(item.createdAt),
      }
    case 'app.gainforest.feed.defs#burstItem':
      return {
        type: 'burst',
        did: item.did,
        total: item.total,
        from: Date.parse(item.from),
        to: Date.parse(item.to),
        subjects: item.subjects,
      }
    case 'app.gainforest.feed.defs#audioItem':
      return {
        type: 'audio',
        did: item.did,
        day: item.day,
        deployment: item.deployment ?? null,
        total: item.total,
        at: Date.parse(item.createdAt),
        subjects: item.subjects,
      }
  }
}

/** Short labels for readable assertions: `observation:o1`, `burst(3):o3`, … */
const label = (item: ActivityFeedItem): string => {
  switch (item.$type) {
    case 'app.gainforest.feed.defs#recordItem':
      return `${item.kind}:${rkeyOf(item.uri)}`
    case 'app.gainforest.feed.defs#repostItem':
      return `repost:${rkeyOf(item.uri)}`
    case 'app.gainforest.feed.defs#burstItem':
      return `burst(${String(item.total)}):${item.subjects.map(rkeyOf).join(',')}`
    case 'app.gainforest.feed.defs#audioItem':
      return `audio(${String(item.total)}):${item.day}`
  }
}

const labels = (output: GetFeedOutput): string[] => output.feed.map(label)

describe('GainForest activity feed against Hyperindex Postgres', () => {
  let fixture: RecordFixture
  let service: FeedService
  let metrics: Metrics

  /** The HTTP application over a feed service, as clients reach it. */
  const appFor = (reader: FeedService) =>
    createApp(
      { checkCompatibility: () => Promise.resolve({ compatible: true }) },
      { skeleton: reader, feed: reader },
      metrics,
      pino({ enabled: false }),
    )

  const postJson = (path: string, body: unknown): Request =>
    new Request(`http://localhost/xrpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  /** A feed service over the fixture, optionally with tiny scan windows. */
  const serviceFor = (scanRowAttempts?: readonly number[]): FeedService =>
    new FeedService(
      new FeedRegistry([
        createActivityFeed(
          { database: fixture.database, metrics },
          scanRowAttempts === undefined ? {} : { scanRowAttempts },
        ),
      ]),
    )

  beforeEach(async () => {
    fixture = await RecordFixture.create(TEST_DATABASE_URL)
    metrics = new Metrics()
    service = serviceFor()
  })

  afterEach(async () => {
    await fixture.close()
  })

  const request = (
    options: {
      readonly filter?: string
      readonly following?: boolean
      readonly viewerDid?: string
      readonly limit?: number
      readonly cursor?: string
    } = {},
  ): FeedRequest => ({
    feedId: ACTIVITY_FEED_ID,
    params: {
      $type: ACTIVITY_FEED_PARAMS_TYPE,
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      ...(options.following === undefined
        ? {}
        : { following: options.following }),
      ...(options.viewerDid === undefined
        ? {}
        : { viewerDid: options.viewerDid }),
    },
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  })

  /** Pages through the whole feed, returning every page. */
  const walk = async (
    options: Parameters<typeof request>[0] = {},
    limit = 50,
    reader: FeedService = service,
  ): Promise<GetFeedOutput[]> => {
    const pages: GetFeedOutput[] = []
    let cursor: string | undefined
    do {
      const page = await reader.getFeed(
        request({
          ...options,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      )
      pages.push(page)
      cursor = page.cursor
      expect(pages.length).toBeLessThan(500)
    } while (cursor !== undefined)
    return pages
  }

  const allItems = async (
    options: Parameters<typeof request>[0] = {},
    limit = 50,
    reader: FeedService = service,
  ): Promise<ActivityFeedItem[]> =>
    (await walk(options, limit, reader)).flatMap((page) => page.feed)

  describe('selection', () => {
    it('selects the four record kinds newest first and serves valid wire items', async () => {
      const did = randomDid()
      const sidecarFree = observation(did, 'o1', minute(40))
      await fixture.seed([
        project(did, 'c1', minute(10)),
        organization(did, minute(20)),
        post(did, 'p1', minute(30)),
        sidecarFree,
      ])

      const output = await service.getFeed(request())

      expect(labels(output)).toEqual([
        'observation:o1',
        'post:p1',
        'organization:self',
        'project:c1',
      ])
      expect(output.cursor).toBeUndefined()
      expect(() => $output.schema.$parse(output)).not.toThrow()
      expect(output.feed[0]).toMatchObject({
        uri: uriOf(sidecarFree),
        cid,
        did,
      })
    })

    it.each([
      ['project', ['project:c1']],
      ['observation', ['observation:o1']],
      ['organization', ['organization:self']],
      ['post', ['post:p1']],
    ])('limits the %s filter to that kind', async (filter, expected) => {
      const did = randomDid()
      await fixture.seed([
        project(did, 'c1', minute(10)),
        organization(did, minute(20)),
        post(did, 'p1', minute(30)),
        observation(did, 'o1', minute(40)),
        audio(did, 'a1', minute(50)),
        repost(did, 'r1', minute(60), post(randomDid(), 'other', minute(5))),
      ])

      expect(labels(await service.getFeed(request({ filter })))).toEqual(
        expected,
      )
    })

    it('limits the audio filter to audio groups', async () => {
      const did = randomDid()
      await fixture.seed([
        observation(did, 'o1', minute(40)),
        audio(did, 'a1', minute(50)),
      ])

      expect(
        labels(await service.getFeed(request({ filter: 'audio' }))),
      ).toEqual(['audio(1):2026-03-01'])
    })

    it('excludes replies and community-event posts but keeps tagged and null-reply posts', async () => {
      const did = randomDid()
      await fixture.seed([
        post(did, 'plain', minute(1)),
        post(did, 'reply', minute(2), {
          reply: {
            root: { uri: 'at://x/y/z', cid },
            parent: { uri: 'at://x/y/z', cid },
          },
        }),
        post(did, 'event', minute(3), { tags: ['community-event'] }),
        post(did, 'tagged', minute(4), { tags: ['bioblitz', 'field'] }),
        post(did, 'nullreply', minute(5), { reply: null }),
      ])

      expect(
        labels(await service.getFeed(request({ filter: 'post' }))),
      ).toEqual(['post:nullreply', 'post:tagged', 'post:plain'])
    })

    it('includes only projects typed project or Project', async () => {
      const did = randomDid()
      await fixture.seed([
        project(did, 'lower', minute(1), 'project'),
        project(did, 'upper', minute(2), 'Project'),
        project(did, 'other', minute(3), 'hypercert'),
        {
          did,
          collection: PROJECT,
          rkey: 'untyped',
          createdAt: minute(4),
        },
      ])

      expect(
        labels(await service.getFeed(request({ filter: 'project' }))),
      ).toEqual(['project:upper', 'project:lower'])
    })

    it('never selects donations or other collections', async () => {
      const did = randomDid()
      await fixture.seed([
        { did, collection: RECEIPT, rkey: 'd1', createdAt: minute(5) },
        {
          did,
          collection: 'app.gainforest.feed.like',
          rkey: 'l1',
          createdAt: minute(6),
        },
        post(did, 'p1', minute(1)),
      ])

      expect(labels(await service.getFeed(request()))).toEqual(['post:p1'])
    })

    it('ignores records whose createdAt Hyperindex could not parse', async () => {
      const did = randomDid()
      await fixture.seed([
        post(did, 'good', minute(1)),
        post(did, 'malformed', null, { createdAt: 'yesterday-ish' }),
        post(did, 'missing', null),
      ])

      expect(labels(await service.getFeed(request()))).toEqual(['post:good'])
    })

    it('omits the cid of a record whose event carried none and still serves a valid page', async () => {
      const did = randomDid()
      const original = post(did, 'original', minute(1))
      await fixture.seed([
        { ...original, cid: '' },
        { ...post(did, 'with-cid', minute(2)) },
        {
          ...repost(randomDid(), 'r1', minute(3), original),
          cid: '',
        },
      ])

      const output = await service.getFeed(request())

      expect(labels(output)).toEqual([
        'repost:r1',
        'post:with-cid',
        'post:original',
      ])
      expect(output.feed[0]).not.toHaveProperty('cid')
      expect(output.feed[1]).toHaveProperty('cid', cid)
      expect(output.feed[2]).not.toHaveProperty('cid')
      expect(() => $output.schema.$parse(output)).not.toThrow()
    })

    it('ignores records Hyperindex has not validated', async () => {
      const did = randomDid()
      await fixture.seed([
        { ...post(did, 'valid', minute(1)) },
        { ...post(did, 'invalid', minute(2)), validation: 'invalid' },
        { ...post(did, 'unknown', minute(3)), validation: 'unknown_schema' },
        {
          ...observation(did, 'broken', minute(4)),
          validation: 'validation_error',
        },
      ])

      expect(labels(await service.getFeed(request()))).toEqual(['post:valid'])
    })
  })

  describe('request defaults', () => {
    it('serves the global feed of every kind when params are omitted', async () => {
      const did = randomDid()
      await fixture.seed([
        post(did, 'p1', minute(2)),
        observation(did, 'o1', minute(1)),
        audio(did, 'a1', minute(3)),
      ])

      const omitted = await service.getFeed({ feedId: ACTIVITY_FEED_ID })

      expect(labels(omitted)).toEqual([
        'audio(1):2026-03-01',
        'post:p1',
        'observation:o1',
      ])
      expect(omitted).toEqual(await service.getFeed(request()))
      await expect(
        service.getFeedSkeleton({ feedId: ACTIVITY_FEED_ID }),
      ).resolves.toEqual(await service.getFeedSkeleton(request()))
    })

    it('serves a request with only a feedId over HTTP', async () => {
      await fixture.seed([post(randomDid(), 'p1', minute(1))])

      const response = await appFor(service).fetch(
        postJson('app.gainforest.feed.getFeed', { feedId: ACTIVITY_FEED_ID }),
      )

      expect(response.status).toBe(200)
    })
  })

  describe('record dates', () => {
    const poison = (did: string, original: SeedRecord): SeedRecord[] => [
      post(did, 'far-future-post', '2099-06-01T00:00:00.000Z'),
      post(did, 'year-10000-post', '10000-01-01T04:59:59Z'),
      post(did, 'before-1970-post', '1969-12-31T23:59:59.000Z'),
      observation(did, 'far-future-observation', '2099-06-01T00:00:01.000Z'),
      observation(did, 'year-10000-observation', '10000-01-01T04:59:59Z'),
      project(did, 'far-future-project', '2099-06-01T00:00:02.000Z'),
      project(did, 'year-10000-project', '10000-01-01T04:59:59Z'),
      organization(randomDid(), '10000-01-01T04:59:59Z'),
      organization(randomDid(), '2099-06-01T00:00:03.000Z'),
      audio(did, 'far-future-audio', '2099-06-01T00:00:04.000Z'),
      audio(did, 'year-10000-audio', '10000-01-01T04:59:59Z'),
      repost(did, 'far-future-repost', '2099-06-01T00:00:05.000Z', original),
      repost(did, 'year-10000-repost', '10000-01-01T04:59:59Z', original),
    ]

    it('ignores records dated in year 10000, far ahead, or before 1970, in every kind, and keeps the order', async () => {
      const did = randomDid()
      const original = post(randomDid(), 'original', minute(1))
      await fixture.seed([
        original,
        project(did, 'c1', minute(2)),
        observation(did, 'o1', minute(3)),
        post(did, 'p1', minute(4)),
        audio(did, 'a1', minute(5)),
        ...poison(did, original),
      ])

      const output = await service.getFeed(request())

      expect(labels(output)).toEqual([
        'audio(1):2026-03-01',
        'post:p1',
        'observation:o1',
        'project:c1',
        'post:original',
      ])
      expect(() => $output.schema.$parse(output)).not.toThrow()
      for (const filter of ['post', 'observation', 'project', 'audio']) {
        await expect(
          service.getFeed(request({ filter })),
        ).resolves.toMatchObject({ feed: expect.any(Array) as unknown })
      }
    })

    it('answers HTTP 200 on both procedures while such records exist', async () => {
      const did = randomDid()
      const original = post(randomDid(), 'original', minute(1))
      await fixture.seed([
        original,
        post(did, 'p1', minute(4)),
        ...poison(did, original),
      ])
      const app = appFor(service)

      for (const procedure of ['getFeed', 'getFeedSkeleton']) {
        for (const filter of ['all', 'post', 'audio']) {
          const response = await app.fetch(
            postJson(`app.gainforest.feed.${procedure}`, {
              feedId: ACTIVITY_FEED_ID,
              params: { $type: ACTIVITY_FEED_PARAMS_TYPE, filter },
            }),
          )
          expect(response.status, `${procedure} ${filter}`).toBe(200)
        }
      }
    })

    it('does not count out-of-range recordings in an audio group', async () => {
      const did = randomDid()
      const folder = `at://${did}/app.gainforest.ac.deployment/f`
      const now = Date.now()
      await fixture.seed([
        audio(did, 'recent', new Date(now - 3_600_000).toISOString(), folder),
        audio(did, 'ahead', new Date(now + 3_600_000).toISOString(), folder),
        audio(did, 'far-future', '2099-06-01T00:00:00.000Z', folder),
        audio(did, 'year-10000', '10000-01-01T04:59:59Z', folder),
      ])

      const items = (await service.getFeed(request({ filter: 'audio' }))).feed

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        total: 1,
        subjects: [`at://${did}/${AUDIO}/recent`],
      })
    })

    it('reads records up to five minutes ahead but not ten', async () => {
      const did = randomDid()
      const now = Date.now()
      await fixture.seed([
        post(
          did,
          'two-minutes-ahead',
          new Date(now + 2 * 60_000).toISOString(),
        ),
        post(
          did,
          'ten-minutes-ahead',
          new Date(now + 10 * 60_000).toISOString(),
        ),
        post(did, 'past', minute(1)),
      ])

      expect(labels(await service.getFeed(request()))).toEqual([
        'post:two-minutes-ahead',
        'post:past',
      ])
    })
  })

  describe('reposts', () => {
    it('appear only in the all filter, at the repost time, pointing at the repost record', async () => {
      const author = randomDid()
      const reposter = randomDid()
      const original = post(author, 'original', minute(1))
      const repostRecord = repost(reposter, 'r1', minute(50), original)
      await fixture.seed([original, repostRecord])

      const all = await service.getFeed(request())
      expect(labels(all)).toEqual(['repost:r1', 'post:original'])
      expect(all.feed[0]).toMatchObject({
        $type: 'app.gainforest.feed.defs#repostItem',
        uri: uriOf(repostRecord),
        did: reposter,
        subject: uriOf(original),
      })
      for (const filter of ['post', 'observation', 'project', 'organization']) {
        expect(
          labels(await service.getFeed(request({ filter }))),
        ).not.toContain('repost:r1')
      }
    })

    it('drops reposts of missing, invalid, unsupported, or own records', async () => {
      const author = randomDid()
      const reposter = randomDid()
      const kept = post(author, 'kept', minute(1))
      const invalid = {
        ...post(author, 'invalid', minute(2)),
        validation: 'invalid',
      }
      const org = organization(author, minute(3))
      const own = post(reposter, 'own', minute(4))
      await fixture.seed([
        kept,
        invalid,
        org,
        own,
        repost(reposter, 'ok', minute(10), kept),
        repost(reposter, 'to-invalid', minute(11), invalid),
        repost(reposter, 'to-org', minute(12), org),
        repost(reposter, 'to-own', minute(13), own),
        repost(
          reposter,
          'to-missing',
          minute(14),
          post(author, 'never-seeded', minute(0)),
        ),
      ])

      expect(
        labels(await service.getFeed(request({ limit: 50 }))).filter((entry) =>
          entry.startsWith('repost:'),
        ),
      ).toEqual(['repost:ok'])
    })
  })

  describe('repost subjects', () => {
    it('count only when the subject would itself be a feed record', async () => {
      const author = randomDid()
      const reposter = randomDid()
      const topLevelPost = post(author, 'top-level', minute(1))
      const reply = post(author, 'reply', minute(2), {
        reply: {
          root: { uri: 'at://x/y/z', cid },
          parent: { uri: 'at://x/y/z', cid },
        },
      })
      const eventPost = post(author, 'event', minute(3), {
        tags: ['community-event'],
      })
      const project1 = project(author, 'project', minute(4), 'project')
      const project2 = project(author, 'upper', minute(5), 'Project')
      const otherType = project(author, 'other-type', minute(6), 'hypercert')
      const untyped: SeedRecord = {
        did: author,
        collection: PROJECT,
        rkey: 'untyped',
        createdAt: minute(7),
      }
      const sighting = observation(author, 'sighting', minute(8))
      const subjects = [
        topLevelPost,
        reply,
        eventPost,
        project1,
        project2,
        otherType,
        untyped,
        sighting,
      ]
      await fixture.seed([
        ...subjects,
        ...subjects.map((subject, index) =>
          repost(reposter, `r${String(index)}`, minute(20 + index), subject),
        ),
      ])

      const reposts = (await allItems()).filter(
        (item) => item.$type === 'app.gainforest.feed.defs#repostItem',
      )

      expect(reposts.map((item) => rkeyOf(item.uri)).sort()).toEqual([
        'r0', // top-level post
        'r3', // project
        'r4', // Project
        'r7', // observation
      ])
    })
  })

  describe('following', () => {
    it('limits every kind to followed authors and reposts to the reposter', async () => {
      const viewer = randomDid()
      const followed = randomDid()
      const stranger = randomDid()
      const original = post(stranger, 'subject', minute(1))
      await fixture.seed([
        follow(viewer, followed),
        project(followed, 'c1', minute(10)),
        post(followed, 'p1', minute(20)),
        observation(followed, 'o1', minute(30)),
        organization(followed, minute(40)),
        audio(followed, 'a1', minute(50)),
        repost(followed, 'r-by-followed', minute(60), original),
        repost(
          stranger,
          'r-by-stranger',
          minute(61),
          project(followed, 'c1', minute(10)),
        ),
        post(stranger, 'p-stranger', minute(70)),
        original,
      ])

      const output = await service.getFeed(
        request({ following: true, viewerDid: viewer }),
      )

      expect(labels(output)).toEqual([
        'repost:r-by-followed',
        'audio(1):2026-03-01',
        'organization:self',
        'observation:o1',
        'post:p1',
        'project:c1',
      ])
    })

    it('returns an empty page for a viewer who follows nobody', async () => {
      const viewer = randomDid()
      await fixture.seed([post(randomDid(), 'p1', minute(1))])

      await expect(
        service.getFeed(request({ following: true, viewerDid: viewer })),
      ).resolves.toEqual({ feed: [] })
    })

    it('ignores follows Hyperindex has not validated and follows without a DID subject', async () => {
      const viewer = randomDid()
      const author = randomDid()
      await fixture.seed([
        { ...follow(viewer, author), validation: 'invalid' },
        {
          did: viewer,
          collection: FOLLOW,
          rkey: 'odd',
          createdAt: minute(0),
          json: { subject: 42 },
        },
        post(author, 'p1', minute(1)),
      ])

      await expect(
        service.getFeed(request({ following: true, viewerDid: viewer })),
      ).resolves.toEqual({ feed: [] })
    })

    it("does not follow other viewers' follows", async () => {
      const viewer = randomDid()
      const otherViewer = randomDid()
      const author = randomDid()
      await fixture.seed([
        follow(otherViewer, author),
        post(author, 'p1', minute(1)),
      ])

      await expect(
        service.getFeed(request({ following: true, viewerDid: viewer })),
      ).resolves.toEqual({ feed: [] })
    })

    it('serves the global feed when following is false even with a viewer', async () => {
      const viewer = randomDid()
      await fixture.seed([post(randomDid(), 'p1', minute(1))])

      expect(
        labels(
          await service.getFeed(
            request({ following: false, viewerDid: viewer }),
          ),
        ),
      ).toEqual(['post:p1'])
    })
  })

  describe('bursts', () => {
    it('collapses two or more adjacent observations into one burst with exact counts', async () => {
      const did = randomDid()
      await fixture.seed([
        observation(did, 'o1', minute(1)),
        observation(did, 'o2', minute(2)),
        observation(did, 'o3', minute(3)),
      ])

      const output = await service.getFeed(request())

      expect(output.feed).toEqual([
        {
          $type: 'app.gainforest.feed.defs#burstItem',
          did,
          total: 3,
          from: expect.stringMatching(/^2026-03-01T00:01:00/) as unknown,
          to: expect.stringMatching(/^2026-03-01T00:03:00/) as unknown,
          subjects: [
            `at://${did}/${OBSERVATION}/o3`,
            `at://${did}/${OBSERVATION}/o2`,
            `at://${did}/${OBSERVATION}/o1`,
          ],
        },
      ])
      expect(() => $output.schema.$parse(output)).not.toThrow()
    })

    it('keeps a single observation as a record item', async () => {
      const did = randomDid()
      await fixture.seed([observation(did, 'only', minute(1))])

      expect(labels(await service.getFeed(request()))).toEqual([
        'observation:only',
      ])
    })

    it('joins neighbours exactly 12 hours apart and splits a longer gap', async () => {
      const did = randomDid()
      await fixture.seed([
        observation(did, 'a', minute(0)),
        observation(did, 'b', minute(12 * 60)),
        observation(did, 'c', minute(12 * 60 + 12 * 60)),
        observation(did, 'd', minute(12 * 60 + 12 * 60 + 12 * 60 + 1)),
      ])

      expect(labels(await service.getFeed(request()))).toEqual([
        'observation:d',
        'burst(3):c,b,a',
      ])
    })

    it('is broken by an interleaved row of another kind or another account', async () => {
      const did = randomDid()
      const other = randomDid()
      await fixture.seed([
        observation(did, 'a1', minute(1)),
        observation(did, 'a2', minute(2)),
        post(other, 'between-a', minute(3)),
        observation(did, 'b1', minute(4)),
        observation(did, 'b2', minute(5)),
        observation(other, 'between-b', minute(6)),
        observation(did, 'c1', minute(7)),
        observation(did, 'c2', minute(8)),
      ])

      expect(labels(await service.getFeed(request()))).toEqual([
        'burst(2):c2,c1',
        'observation:between-b',
        'burst(2):b2,b1',
        'post:between-a',
        'burst(2):a2,a1',
      ])
    })

    it('is not broken by an interleaved row the active filter excludes', async () => {
      const did = randomDid()
      const other = randomDid()
      await fixture.seed([
        observation(did, 'a1', minute(1)),
        post(other, 'between', minute(2)),
        observation(did, 'a2', minute(3)),
      ])

      expect(
        labels(await service.getFeed(request({ filter: 'observation' }))),
      ).toEqual(['burst(2):a2,a1'])
      expect(labels(await service.getFeed(request()))).toEqual([
        'observation:a2',
        'post:between',
        'observation:a1',
      ])
    })

    it('counts every member but references only the 20 newest', async () => {
      const did = randomDid()
      await fixture.seed(
        Array.from({ length: 45 }, (_, index) =>
          observation(did, `o${String(index).padStart(2, '0')}`, second(index)),
        ),
      )

      const [item] = (await service.getFeed(request())).feed

      expect(item).toMatchObject({
        $type: 'app.gainforest.feed.defs#burstItem',
        total: 45,
      })
      const subjects = item && 'subjects' in item ? item.subjects : []
      expect(subjects.map(rkeyOf)).toEqual(
        Array.from(
          { length: 20 },
          (_, index) => `o${String(44 - index).padStart(2, '0')}`,
        ),
      )
    })

    it('keeps sightings with a valid bioacoustic sidecar out of bursts', async () => {
      const did = randomDid()
      const sidecar = (source: string) =>
        JSON.stringify({
          gainforestBioacoustics: {
            version: 1,
            sourceAudioUri: source,
            labelCategory: 'bird',
            startTimeSeconds: 1,
            endTimeSeconds: 2,
            minFrequencyHz: 100,
            maxFrequencyHz: 9000,
          },
        })
      const source = `at://${did}/${AUDIO}/src`
      await fixture.seed([
        observation(did, 'photo1', minute(1)),
        observation(did, 'photo2', minute(2)),
        observation(did, 'sound1', minute(3), {
          dynamicProperties: sidecar(source),
          associatedMedia: source,
        }),
        observation(did, 'photo3', minute(4)),
        observation(did, 'photo4', minute(5)),
        // The sidecar is invalid without matching associated media, so the
        // sighting is an ordinary photo sighting.
        observation(did, 'photo5', minute(6), {
          dynamicProperties: sidecar(source),
        }),
        observation(did, 'photo6', minute(7), {
          dynamicProperties: 'not json',
        }),
      ])

      expect(labels(await service.getFeed(request()))).toEqual([
        'burst(4):photo6,photo5,photo4,photo3',
        'observation:sound1',
        'burst(2):photo2,photo1',
      ])
    })

    it('summarizes a burst larger than the first scan window as one item', async () => {
      const did = randomDid()
      const other = randomDid()
      await fixture.seed([
        ...Array.from({ length: 700 }, (_, index) =>
          observation(did, `big${String(index)}`, second(index * 5)),
        ),
        post(other, 'after', minute(500)),
      ])

      const first = await service.getFeed(request({ limit: 1 }))
      expect(labels(first)).toEqual(['post:after'])
      const second_ = await service.getFeed(
        request({
          limit: 1,
          ...(first.cursor === undefined ? {} : { cursor: first.cursor }),
        }),
      )

      expect(second_.feed[0]).toMatchObject({
        $type: 'app.gainforest.feed.defs#burstItem',
        total: 700,
      })
      expect(second_.cursor).toBeUndefined()
    })
  })

  describe('audio', () => {
    it('groups recordings by account, recorder folder, and UTC day', async () => {
      const did = randomDid()
      const folderA = `at://${did}/app.gainforest.ac.deployment/a`
      const folderB = `at://${did}/app.gainforest.ac.deployment/b`
      await fixture.seed([
        audio(did, 'a1', '2026-03-01T01:00:00.000Z', folderA),
        audio(did, 'a2', '2026-03-01T02:00:00.000Z', folderA),
        audio(did, 'b1', '2026-03-01T03:00:00.000Z', folderB),
        audio(did, 'none1', '2026-03-01T04:00:00.000Z'),
        audio(did, 'none2', '2026-03-01T05:00:00.000Z'),
        audio(did, 'next-day', '2026-03-02T00:00:00.000Z', folderA),
        audio(did, 'a-late', '2026-03-01T23:59:59.999Z', folderA),
      ])

      const output = await service.getFeed(request({ filter: 'audio' }))

      expect(output.feed.map(modelOf)).toEqual([
        {
          type: 'audio',
          did,
          day: '2026-03-02',
          deployment: folderA,
          total: 1,
          at: Date.parse('2026-03-02T00:00:00.000Z'),
          subjects: [`at://${did}/${AUDIO}/next-day`],
        },
        {
          type: 'audio',
          did,
          day: '2026-03-01',
          deployment: folderA,
          total: 3,
          at: Date.parse('2026-03-01T23:59:59.999Z'),
          subjects: [
            `at://${did}/${AUDIO}/a-late`,
            `at://${did}/${AUDIO}/a2`,
            `at://${did}/${AUDIO}/a1`,
          ],
        },
        {
          type: 'audio',
          did,
          day: '2026-03-01',
          deployment: null,
          total: 2,
          at: Date.parse('2026-03-01T05:00:00.000Z'),
          subjects: [
            `at://${did}/${AUDIO}/none2`,
            `at://${did}/${AUDIO}/none1`,
          ],
        },
        {
          type: 'audio',
          did,
          day: '2026-03-01',
          deployment: folderB,
          total: 1,
          at: Date.parse('2026-03-01T03:00:00.000Z'),
          subjects: [`at://${did}/${AUDIO}/b1`],
        },
      ])
      expect(() => $output.schema.$parse(output)).not.toThrow()
    })

    it("groups one folder's recordings by the folder's owner, whoever stored them", async () => {
      const organizationDid = randomDid()
      const member = randomDid()
      const folder = `at://${organizationDid}/app.gainforest.ac.deployment/f`
      await fixture.seed([
        audio(organizationDid, 'org1', minute(1), folder),
        audio(member, 'member1', minute(2), folder),
        audio(member, 'member2', minute(3), folder),
      ])

      const output = await service.getFeed(request({ filter: 'audio' }))

      expect(output.feed).toHaveLength(1)
      expect(output.feed[0]).toMatchObject({
        $type: 'app.gainforest.feed.defs#audioItem',
        did: organizationDid,
        deployment: folder,
        total: 3,
        subjects: [
          `at://${member}/${AUDIO}/member2`,
          `at://${member}/${AUDIO}/member1`,
          `at://${organizationDid}/${AUDIO}/org1`,
        ],
      })
      expect(() => $output.schema.$parse(output)).not.toThrow()
    })

    it("scopes the following feed to the folder's owner, not to who stored the recording", async () => {
      const organizationDid = randomDid()
      const member = randomDid()
      const viewerOfOrganization = randomDid()
      const viewerOfMember = randomDid()
      const folder = `at://${organizationDid}/app.gainforest.ac.deployment/f`
      await fixture.seed([
        audio(member, 'member1', minute(1), folder),
        follow(viewerOfOrganization, organizationDid),
        follow(viewerOfMember, member),
      ])

      const organizationFeed = await service.getFeed(
        request({ following: true, viewerDid: viewerOfOrganization }),
      )
      const memberFeed = await service.getFeed(
        request({ following: true, viewerDid: viewerOfMember }),
      )

      expect(labels(organizationFeed)).toEqual(['audio(1):2026-03-01'])
      expect(organizationFeed.feed[0]).toMatchObject({ did: organizationDid })
      expect(memberFeed).toEqual({ feed: [] })
    })

    it('groups recordings without a folder by their own account', async () => {
      const first = randomDid()
      const second = randomDid()
      await fixture.seed([
        audio(first, 'a1', minute(1)),
        audio(first, 'a2', minute(2)),
        audio(second, 'b1', minute(3)),
      ])

      const items = (await service.getFeed(request({ filter: 'audio' }))).feed

      expect(items.map((item) => item.$type)).toEqual([
        'app.gainforest.feed.defs#audioItem',
        'app.gainforest.feed.defs#audioItem',
      ])
      expect(items.map(modelOf)).toMatchObject([
        { did: second, total: 1, deployment: null },
        { did: first, total: 2, deployment: null },
      ])
    })

    it("falls back to the recording's account when the folder's authority is not a DID", async () => {
      const first = randomDid()
      const second = randomDid()
      const folder = 'at://alice.example/app.gainforest.ac.deployment/f'
      await fixture.seed([
        audio(first, 'a1', minute(1), folder),
        audio(second, 'b1', minute(2), folder),
      ])

      const output = await service.getFeed(request({ filter: 'audio' }))

      expect(output.feed.map(modelOf)).toMatchObject([
        { did: second, deployment: folder, total: 1 },
        { did: first, deployment: folder, total: 1 },
      ])
      expect(() => $output.schema.$parse(output)).not.toThrow()
    })

    it('treats a deployment reference that is not an AT-URI as no folder', async () => {
      const did = randomDid()
      await fixture.seed([
        audio(did, 'a1', minute(1), 'not-a-uri'),
        audio(did, 'a2', minute(2)),
      ])

      expect(
        labels(await service.getFeed(request({ filter: 'audio' }))),
      ).toEqual(['audio(2):2026-03-01'])
    })

    it('never repeats a group on a later page, even when its older recordings follow the cursor', async () => {
      const did = randomDid()
      const other = randomDid()
      await fixture.seed([
        audio(did, 'a1', '2026-03-01T01:00:00.000Z'),
        audio(did, 'a2', '2026-03-01T10:00:00.000Z'),
        post(other, 'between', '2026-03-01T05:00:00.000Z'),
        audio(did, 'a3', '2026-03-01T12:00:00.000Z'),
      ])

      const pages = await walk({}, 1)

      expect(pages.flatMap(labels)).toEqual([
        'audio(3):2026-03-01',
        'post:between',
      ])
    })

    it("does not mistake a recording dated beyond the five-minute tolerance for an emitted group's head", async ({
      skip,
    }) => {
      // The emitted-group check runs for groups on the cursor's UTC day. The
      // sibling below sits later that same day, more than five minutes ahead,
      // so the feed must ignore it. Everything else is anchored to the start of
      // the UTC day, so the test does not depend on the time of day: only the
      // last minutes before UTC midnight leave no room for such a sibling.
      const dayMs = 86_400_000
      const now = Date.now()
      const dayStart = Math.floor(now / dayMs) * dayMs
      const sibling = dayStart + dayMs - 1
      skip(
        sibling <= now + 6 * 60_000,
        "fewer than six minutes remain in the current UTC day, so no recording can be dated beyond the five-minute tolerance and still fall on the cursor's UTC day; run it again after UTC midnight",
      )
      const did = randomDid()
      const other = randomDid()
      const folder = `at://${did}/app.gainforest.ac.deployment/f`
      await fixture.seed([
        post(other, 'p1', new Date(dayStart + 2).toISOString()),
        audio(did, 'head', new Date(dayStart).toISOString(), folder),
        audio(did, 'ahead', new Date(sibling).toISOString(), folder),
      ])

      const first = await service.getFeed(request({ limit: 1 }))
      expect(labels(first)).toEqual(['post:p1'])
      expect(first.cursor).toBeDefined()
      const second = await service.getFeed(
        request({
          limit: 1,
          ...(first.cursor === undefined ? {} : { cursor: first.cursor }),
        }),
      )

      expect(second.feed).toEqual([
        expect.objectContaining({
          $type: 'app.gainforest.feed.defs#audioItem',
          did,
          deployment: folder,
          total: 1,
          subjects: [`at://${did}/${AUDIO}/head`],
        }) as unknown,
      ])
    })

    it('summarizes a day of recordings larger than the first scan window', async () => {
      const did = randomDid()
      const other = randomDid()
      await fixture.seed([
        ...Array.from({ length: 650 }, (_, index) =>
          audio(did, `rec${String(index)}`, second(index * 3)),
        ),
        audio(other, 'older', '2026-02-20T10:00:00.000Z'),
      ])

      const items = await allItems({ filter: 'audio' }, 1)

      expect(items.map(label)).toEqual([
        'audio(650):2026-03-01',
        'audio(1):2026-02-20',
      ])
    })
  })

  describe('scan window', () => {
    it('answers a first page that ends above a large old audio day in one statement', async () => {
      const did = randomDid()
      const other = randomDid()
      await fixture.seed([
        ...Array.from({ length: 600 }, (_, index) =>
          audio(did, `old${String(index)}`, '2026-01-05T10:00:00.000Z'),
        ),
        post(other, 'p1', minute(3)),
        post(other, 'p2', minute(2)),
        post(other, 'p3', minute(1)),
      ])
      let statements = 0
      const counting = new FeedService(
        new FeedRegistry([
          createActivityFeed({
            database: {
              query: (text, values) => {
                statements += 1
                return fixture.database.query(text, values)
              },
            },
            metrics,
          }),
        ]),
      )

      const page = await counting.getFeed(request({ limit: 2 }))

      expect(labels(page)).toEqual(['post:p1', 'post:p2'])
      expect(statements).toBe(1)
    })
  })

  describe('scan limit', () => {
    it('fails with a typed, non-retryable error when a run is longer than every scan window', async () => {
      const did = randomDid()
      await fixture.seed(
        Array.from({ length: 12 }, (_, index) =>
          observation(did, `o${String(index).padStart(2, '0')}`, second(index)),
        ),
      )
      const tiny = serviceFor([2, 4])

      await expect(tiny.getFeed(request())).rejects.toMatchObject({
        code: 'ScanLimitExceeded',
        status: 422,
        message: expect.stringContaining('will not help') as unknown,
      })
      // The data itself is fine: the default windows page it.
      expect(labels(await service.getFeed(request()))).toEqual([
        expect.stringMatching(/^burst\(12\):/) as unknown,
      ])
    })

    it('reaches clients as HTTP 422 with the stable error name', async () => {
      const did = randomDid()
      await fixture.seed(
        Array.from({ length: 12 }, (_, index) =>
          observation(did, `o${String(index).padStart(2, '0')}`, second(index)),
        ),
      )

      const response = await appFor(serviceFor([2, 4])).fetch(
        postJson('app.gainforest.feed.getFeed', { feedId: ACTIVITY_FEED_ID }),
      )

      expect(response.status).toBe(422)
      await expect(response.json()).resolves.toMatchObject({
        error: 'ScanLimitExceeded',
      })
      expect(await metrics.registry.metrics()).toContain(
        'hypercerts_feed_errors_total{error="ScanLimitExceeded"} 1',
      )
    })
  })

  describe('pagination', () => {
    it('breaks createdAt ties by URI without repeating or losing rows', async () => {
      const did = randomDid()
      await fixture.seed(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((rkey) =>
          post(did, rkey, minute(10)),
        ),
      )

      const pages = await walk({}, 2)

      expect(pages.map(labels)).toEqual([
        ['post:f', 'post:e'],
        ['post:d', 'post:c'],
        ['post:b', 'post:a'],
      ])
      expect(pages.map((page) => page.cursor !== undefined)).toEqual([
        true,
        true,
        false,
      ])
    })

    it('never points the next page into the middle of a burst', async () => {
      const did = randomDid()
      const other = randomDid()
      await fixture.seed([
        post(other, 'newest', minute(100)),
        ...Array.from({ length: 30 }, (_, index) =>
          observation(
            did,
            `o${String(index).padStart(2, '0')}`,
            minute(10 + index),
          ),
        ),
        post(other, 'oldest', minute(1)),
      ])

      const pages = await walk({}, 2)

      expect(pages.map(labels)).toEqual([
        [
          'post:newest',
          `burst(30):${Array.from({ length: 20 }, (_, index) => `o${String(29 - index).padStart(2, '0')}`).join(',')}`,
        ],
        ['post:oldest'],
      ])
    })

    it('continues exactly after the last item of a full page', async () => {
      const did = randomDid()
      await fixture.seed(
        Array.from({ length: 5 }, (_, index) =>
          post(did, `p${String(index)}`, minute(index)),
        ),
      )

      const first = await service.getFeed(request({ limit: 5 }))
      expect(first.feed).toHaveLength(5)
      expect(first.cursor).toBeUndefined()

      const partial = await service.getFeed(request({ limit: 4 }))
      expect(partial.cursor).toBeDefined()
      const rest = await service.getFeed(
        request({
          limit: 4,
          ...(partial.cursor === undefined ? {} : { cursor: partial.cursor }),
        }),
      )
      expect(labels(rest)).toEqual(['post:p0'])
      expect(rest.cursor).toBeUndefined()
    })

    it('rejects a cursor issued for another feed', async () => {
      const cursor = Buffer.from(
        JSON.stringify({
          version: 1,
          feedId: 'app.gainforest.feed.defs#other',
          value: { value: minute(1), uri: 'at://did:plc:x/y/z' },
        }),
      ).toString('base64url')

      await expect(service.getFeed(request({ cursor }))).rejects.toMatchObject({
        code: 'InvalidCursor',
      })
    })
  })

  describe('skeleton', () => {
    it('flattens the same pages, in the same order, as getFeed', async () => {
      const did = randomDid()
      const other = randomDid()
      const original = post(other, 'original', minute(1))
      await fixture.seed([
        original,
        project(did, 'c1', minute(5)),
        observation(did, 'o1', minute(10)),
        observation(did, 'o2', minute(11)),
        observation(did, 'o3', minute(12)),
        audio(did, 'a1', minute(20)),
        audio(did, 'a2', minute(21)),
        repost(did, 'r1', minute(30), original),
        post(did, 'p1', minute(40)),
      ])

      const full = await service.getFeed(request())
      const skeleton = await service.getFeedSkeleton(request())

      expect(skeleton.feed.map(({ subject }) => rkeyOf(subject))).toEqual([
        'p1',
        'r1',
        'a2',
        'a1',
        'o3',
        'o2',
        'o1',
        'c1',
        'original',
      ])
      expect(skeleton.feed).toEqual(
        full.feed.flatMap((item) =>
          'subjects' in item
            ? item.subjects.map((subject) => ({ subject }))
            : [{ subject: item.uri }],
        ),
      )
      expect(skeleton.cursor).toBe(full.cursor)
    })

    it('shares its cursor with getFeed', async () => {
      const did = randomDid()
      await fixture.seed(
        Array.from({ length: 4 }, (_, index) =>
          post(did, `p${String(index)}`, minute(index)),
        ),
      )

      const full = await service.getFeed(request({ limit: 2 }))
      const skeleton = await service.getFeedSkeleton(request({ limit: 2 }))

      expect(skeleton.cursor).toBeDefined()
      expect(skeleton.cursor).toBe(full.cursor)
    })
  })

  describe('against an independent model', () => {
    // Deterministic pseudo-random numbers keep failures reproducible.
    const random = (seed: number): (() => number) => {
      let state = seed
      return () => {
        state = (state + 0x6d2b79f5) | 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    // Fixed accounts keep the data, and so any failure, reproducible.
    const dids = [
      `did:plc:${'a'.repeat(24)}`,
      `did:plc:${'b'.repeat(24)}`,
      `did:plc:${'c'.repeat(24)}`,
      `did:plc:${'d'.repeat(24)}`,
    ] as const
    // The one-off timestamps the feed must ignore: far future, year 10000
    // (not a valid datetime), and before 1970.
    const outOfRange = [
      '2099-06-01T00:00:00.000Z',
      '10000-01-01T04:59:59Z',
      '1969-12-31T23:59:59.000Z',
    ] as const
    const sourceAudio = 'at://did:plc:x/app.gainforest.ac.audio/s'
    const sidecar = JSON.stringify({
      gainforestBioacoustics: {
        version: 1,
        sourceAudioUri: sourceAudio,
        labelCategory: 'frog',
        startTimeSeconds: 0,
        endTimeSeconds: 1,
        minFrequencyHz: 1,
        maxFrequencyHz: 2,
      },
    })

    /**
     * Dense data with 12-hour boundaries and UTC-midnight crossings. With
     * `ties`, about a third of the rows share the previous row's exact
     * timestamp, across kinds and inside one account's burst.
     */
    const randomDataset = (seed: number, ties: boolean): SeedRecord[] => {
      const next = random(seed)
      const pick = <T>(values: readonly [T, ...T[]]): T =>
        values[Math.floor(next() * values.length)] ?? values[0]
      const folders = [
        undefined,
        `at://${dids[0]}/app.gainforest.ac.deployment/f1`,
        `at://${dids[1]}/app.gainforest.ac.deployment/f2`,
        // A handle is not a DID, so its recordings group by their own account.
        'at://alice.example/app.gainforest.ac.deployment/f3',
      ] as const
      const records: SeedRecord[] = []
      let serial = 0
      let clock = BASE
      const key = (): string => `k${String(serial++).padStart(4, '0')}`
      const tick = (): string => {
        const roll = next()
        if (ties && roll < 0.35) {
          // Exactly the previous timestamp.
        } else if (roll < 0.9) {
          clock += (ties ? 0 : 1) + Math.floor(next() * 20 * 60_000)
        } else if (roll < 0.94) {
          clock += 12 * 3_600_000 // exactly 12 hours: still one burst
        } else if (roll < 0.97) {
          clock += 12 * 3_600_000 + 1 // 12 hours and a millisecond: split
        } else {
          clock += 3 * 3_600_000
        }
        return new Date(clock).toISOString()
      }

      for (let step = 0; step < 260; step += 1) {
        const did = pick(dids)
        const roll = next()
        const createdAt = next() < 0.04 ? pick(outOfRange) : tick()
        const validation = next() < 0.04 ? 'invalid' : 'valid'
        if (roll < 0.5) {
          records.push({
            ...observation(
              did,
              key(),
              next() < 0.03 ? null : createdAt,
              next() < 0.1
                ? { dynamicProperties: sidecar, associatedMedia: sourceAudio }
                : {},
            ),
            validation,
          })
        } else if (roll < 0.6) {
          records.push({
            ...post(
              did,
              key(),
              createdAt,
              next() < 0.2
                ? { reply: { root: { uri: 'at://x/y/z', cid } } }
                : next() < 0.1
                  ? { tags: ['community-event'] }
                  : {},
            ),
            validation,
          })
        } else if (roll < 0.66) {
          records.push({
            ...project(
              did,
              key(),
              createdAt,
              pick(['project', 'Project', 'other'] as const),
            ),
            validation,
          })
        } else if (roll < 0.7) {
          records.push({
            ...organization(did, createdAt),
            rkey: key(),
            validation,
          })
        } else if (roll < 0.8) {
          // Any record can be a subject; most are not eligible ones.
          const [firstSubject, ...otherSubjects] = records
          const subject =
            firstSubject === undefined
              ? undefined
              : pick([firstSubject, ...otherSubjects])
          records.push({
            ...repost(
              did,
              key(),
              createdAt,
              subject ?? post(did, 'missing', createdAt),
            ),
            validation,
          })
        } else {
          records.push({
            ...audio(did, key(), createdAt, pick(folders)),
            validation,
          })
        }
      }
      return records
    }

    /** Pages the feed to the end and compares it with the model. */
    const expectModelFeed = async (
      records: readonly SeedRecord[],
      reader: FeedService,
      scope?: { readonly viewer: string; readonly followed: Set<string> },
    ): Promise<void> => {
      const uriRank = await fixture.uriOrder(records.map(uriOf))
      const filters = scope
        ? ['all', 'observation', 'audio']
        : ['all', 'project', 'observation', 'organization', 'post', 'audio']
      for (const filter of filters) {
        const expected = modelFeed(records, {
          filter,
          uriRank,
          ...(scope === undefined ? {} : { followed: scope.followed }),
        })
        for (const limit of [1, 2, 3, 7, 20, 50]) {
          const actual = (
            await allItems(
              {
                filter,
                ...(scope === undefined
                  ? {}
                  : { following: true, viewerDid: scope.viewer }),
              },
              limit,
              reader,
            )
          ).map(modelOf)
          expect(actual, `filter ${filter}, limit ${String(limit)}`).toEqual(
            expected,
          )
        }
      }
    }

    it('really does retry with tiny scan windows, so the comparisons above cover that path', async () => {
      const records = randomDataset(1, true)
      await fixture.seed(records)
      let statements = 0
      const counting = new FeedService(
        new FeedRegistry([
          createActivityFeed(
            {
              database: {
                query: (text, values) => {
                  statements += 1
                  return fixture.database.query(text, values)
                },
              },
              metrics,
            },
            { scanRowAttempts: [8, 32, 128, 100_000] },
          ),
        ]),
      )

      const pages = await walk({}, 7, counting)

      expect(statements).toBeGreaterThan(pages.length)
      expect(
        statements,
        'every page stays within the four scan windows',
      ).toBeLessThanOrEqual(pages.length * 4)
    })

    const configurations = [
      {
        name: 'production scan windows, unique timestamps',
        ties: false,
        attempts: undefined,
        seeds: [1, 2, 3, 4],
      },
      {
        name: 'tiny scan windows, unique timestamps',
        ties: false,
        attempts: [8, 32, 128, 100_000],
        seeds: [1, 2, 3],
      },
      {
        name: 'tiny scan windows, tied timestamps',
        ties: true,
        attempts: [8, 32, 128, 100_000],
        seeds: [1, 2, 3],
      },
      {
        name: 'production scan windows, tied timestamps',
        ties: true,
        attempts: undefined,
        seeds: [1, 2],
      },
      {
        name: 'many small scan windows, tied timestamps',
        ties: true,
        attempts: [8, 9, 10, 12, 16, 24, 32, 100_000],
        seeds: [1],
      },
    ] as const

    describe.each(configurations)('$name', (configuration) => {
      const reader = (): FeedService =>
        configuration.attempts === undefined
          ? service
          : serviceFor(configuration.attempts)

      it.each(configuration.seeds)(
        'pages random dataset %i exactly like the model for every filter and page size',
        async (seed) => {
          const records = randomDataset(seed, configuration.ties)
          await fixture.seed(records)

          await expectModelFeed(records, reader())
        },
        180_000,
      )

      it('scopes a random dataset to followed accounts exactly like the model', async () => {
        const records = randomDataset(11, configuration.ties)
        const viewer = randomDid()
        const followed = new Set([dids[0], dids[2]])
        await fixture.seed([
          ...records,
          ...[...followed].map((did) => follow(viewer, did)),
        ])

        await expectModelFeed(records, reader(), { viewer, followed })
      }, 180_000)
    })
  })
})

describe('Database readiness against Hyperindex Postgres', () => {
  const logger = pino({ enabled: false })
  let fixture: RecordFixture
  let database: Database

  beforeEach(async () => {
    // The fixture creates public.record when the database has none.
    fixture = await RecordFixture.create(TEST_DATABASE_URL)
    database = new Database(
      loadConfig({
        DATABASE_URL: TEST_DATABASE_URL,
        SERVICE_DID: 'did:web:feed.example',
        DATABASE_MAX_CONNECTIONS: '2',
      }),
      logger,
    )
  })

  afterEach(async () => {
    await database.close()
    await fixture.close()
  })

  it('is compatible with the Hyperindex record table and rejects writes', async () => {
    await expect(database.checkCompatibility()).resolves.toEqual({
      compatible: true,
    })
    const did = randomDid()
    await expect(
      database.query(
        `INSERT INTO record (uri, cid, did, collection, json)
         VALUES ($1, $2, $3, $4, '{}')`,
        [`at://${did}/${POST}/read-only`, cid, did, POST],
      ),
    ).rejects.toThrow(/read-only/i)
  })
})
