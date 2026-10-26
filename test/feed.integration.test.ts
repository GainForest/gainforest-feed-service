import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import pino from 'pino'

import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { Database } from '../src/database.js'
import {
  decodeCursor,
  encodeCursor,
  timestampUriCursor,
} from '../src/feed/cursor.js'
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
import { $output as $skeletonOutput } from '../src/lexicons/app/gainforest/feed/getFeedSkeleton.js'
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

/**
 * A compact, comparable form of service items. Group keys become run numbers
 * in order of appearance, so items of one run compare equal to the model's.
 */
const modelOf = (items: readonly ActivityFeedItem[]): ModelItem[] => {
  const runs = new Map<string, number>()
  const runOf = (groupKey: string): number => {
    const known = runs.get(groupKey)
    if (known !== undefined) return known
    runs.set(groupKey, runs.size)
    return runs.size - 1
  }
  return items.map((item): ModelItem => {
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
          run: runOf(item.groupKey),
          continued: item.continued,
          capped: item.capped,
        }
      case 'app.gainforest.feed.defs#audioItem':
        return {
          type: 'audio',
          did: item.did,
          deployment: item.deployment ?? null,
          total: item.total,
          from: Date.parse(item.from),
          to: Date.parse(item.to),
          subjects: item.subjects,
          run: runOf(item.groupKey),
          continued: item.continued,
          capped: item.capped,
        }
    }
  })
}

/** Short labels for readable assertions: `observation:o1`, `burst(3):o3,o2,o1`, … */
const label = (item: ActivityFeedItem): string => {
  switch (item.$type) {
    case 'app.gainforest.feed.defs#recordItem':
      return `${item.kind}:${rkeyOf(item.uri)}`
    case 'app.gainforest.feed.defs#repostItem':
      return `repost:${rkeyOf(item.uri)}`
    case 'app.gainforest.feed.defs#burstItem':
      return `burst(${String(item.total)}):${item.subjects.map(rkeyOf).join(',')}`
    case 'app.gainforest.feed.defs#audioItem':
      return `audio(${String(item.total)}):${item.subjects.map(rkeyOf).join(',')}`
  }
}

/** The group fields of the burst and audio items, in feed order. */
const chunksOf = (items: readonly ActivityFeedItem[]) =>
  items.flatMap((item) =>
    'groupKey' in item
      ? [
          {
            type: item.$type.slice(item.$type.indexOf('#') + 1),
            total: item.total,
            continued: item.continued,
            capped: item.capped,
            groupKey: item.groupKey,
          },
        ]
      : [],
  )

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** The shape of every chunk, without the group key that tells the runs apart. */
const flagsOf = (items: readonly ActivityFeedItem[]) =>
  chunksOf(items).map(({ groupKey: _groupKey, ...flags }) => flags)

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

  /** One request to a procedure over HTTP, as a client sends it. */
  const call = async (
    procedure: 'getFeed' | 'getFeedSkeleton',
    body: FeedRequest,
    reader: FeedService = service,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await appFor(reader).fetch(
      postJson(`app.gainforest.feed.${procedure}`, body),
    )
    return { status: response.status, body: (await response.json()) as unknown }
  }

  /** A feed service over the fixture, optionally with a small group cap. */
  const serviceFor = (maxGroupRows?: number): FeedService =>
    new FeedService(
      new FeedRegistry([
        createActivityFeed(
          { database: fixture.database, metrics },
          maxGroupRows === undefined ? {} : { maxGroupRows },
        ),
      ]),
    )

  /** A feed service that records the statements it sends to the database. */
  const countingService = (maxGroupRows?: number) => {
    let sent: { text: string; values: readonly unknown[] }[] = []
    const counted = new FeedService(
      new FeedRegistry([
        createActivityFeed(
          {
            database: {
              query: (text, values = []) => {
                sent.push({ text, values })
                return fixture.database.query(text, values)
              },
            },
            metrics,
          },
          maxGroupRows === undefined ? {} : { maxGroupRows },
        ),
      ]),
    )
    return {
      service: counted,
      statements: () => sent.length,
      lastStatement: () => sent.at(-1),
      reset: () => {
        sent = []
      },
    }
  }

  /**
   * Runs a statement the service sent under EXPLAIN ANALYZE and returns the
   * scans of `record` the plan contains, with the number of times each one ran.
   * The follows lookup (alias `follow`) is left out: it is not a feed arm.
   */
  const feedScansOf = async (statement: {
    text: string
    values: readonly unknown[]
  }): Promise<{ alias: string; loops: number }[]> => {
    const { rows } = await fixture.database.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
      statement.values,
    )
    const scans: { alias: string; loops: number }[] = []
    const visit = (node: unknown): void => {
      if (!isObject(node)) return
      const { Alias: alias, Plans: children } = node
      const loops = node['Actual Loops']
      if (
        node['Relation Name'] === 'record' &&
        typeof alias === 'string' &&
        typeof loops === 'number' &&
        alias !== 'follow'
      ) {
        scans.push({ alias, loops })
      }
      if (Array.isArray(children)) children.forEach(visit)
    }
    // Each row is `{ "QUERY PLAN": [{ "Plan": { ... } }] }`.
    for (const row of rows as readonly unknown[]) {
      const plans = isObject(row) ? row['QUERY PLAN'] : undefined
      if (!Array.isArray(plans)) continue
      for (const entry of plans) {
        if (isObject(entry)) visit(entry.Plan)
      }
    }
    return scans
  }

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
      ).toEqual(['audio(1):a1'])
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
        { ...audio(did, 'broken-audio', minute(5)), validation: 'invalid' },
        { ...audio(did, 'good-audio', minute(6)) },
        {
          ...audio(did, 'unknown-audio', minute(7)),
          validation: 'unknown_schema',
        },
      ])

      expect(labels(await service.getFeed(request()))).toEqual([
        'audio(1):good-audio',
        'post:valid',
      ])
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
        'audio(1):a1',
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
        'audio(1):a1',
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
        // Every kind is scoped, so none of a stranger's records may appear.
        project(stranger, 'c-stranger', minute(71)),
        organization(stranger, minute(72)),
        observation(stranger, 'o-stranger', minute(73)),
        audio(stranger, 'a-stranger', minute(74)),
        original,
      ])

      const output = await service.getFeed(
        request({ following: true, viewerDid: viewer }),
      )

      expect(labels(output)).toEqual([
        'repost:r-by-followed',
        'audio(1):a1',
        'organization:self',
        'observation:o1',
        'post:p1',
        'project:c1',
      ])
    })

    describe('a viewer who follows nobody', () => {
      /** One record of every kind by strangers, and a follow by someone else. */
      const seedStrangers = async (): Promise<void> => {
        const stranger = randomDid()
        await fixture.seed([
          post(stranger, 'p1', minute(1)),
          project(stranger, 'c1', minute(2)),
          organization(stranger, minute(3)),
          observation(stranger, 'o1', minute(4)),
          audio(stranger, 'a1', minute(5)),
          repost(
            stranger,
            'r1',
            minute(6),
            post(randomDid(), 'other', minute(0)),
          ),
          follow(randomDid(), stranger),
        ])
      }

      it('gets an empty page in one statement, whatever the other accounts store', async () => {
        const viewer = randomDid()
        await seedStrangers()
        const counted = countingService()

        await expect(
          counted.service.getFeed(
            request({ following: true, viewerDid: viewer }),
          ),
        ).resolves.toEqual({ feed: [] })
        expect(counted.statements()).toBe(1)
      })

      // Without the guard in every arm each arm walks its whole collection
      // for a filter that nothing passes: 1.4 s on a table ten times the size
      // of staging, against 1 ms with it. The page is empty either way, so
      // only the plan shows it.
      it('reads no feed collection', async () => {
        const viewer = randomDid()
        await seedStrangers()
        const counted = countingService()
        await counted.service.getFeed(
          request({ following: true, viewerDid: viewer }),
        )

        const statement = counted.lastStatement()
        expect(statement).toBeDefined()
        const scans = await feedScansOf(statement ?? { text: '', values: [] })

        // The six arms are in the plan, and none of them ran.
        expect(scans.length).toBeGreaterThanOrEqual(6)
        expect(scans.filter(({ loops }) => loops > 0)).toEqual([])
      })
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
          groupKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) as unknown,
          continued: false,
          capped: false,
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
  })

  describe('audio', () => {
    it('groups adjacent recordings by owner and recorder folder', async () => {
      const did = randomDid()
      const folderA = `at://${did}/app.gainforest.ac.deployment/a`
      const folderB = `at://${did}/app.gainforest.ac.deployment/b`
      await fixture.seed([
        audio(did, 'a1', minute(60), folderA),
        audio(did, 'a2', minute(120), folderA),
        audio(did, 'b1', minute(180), folderB),
        audio(did, 'none1', minute(240)),
        audio(did, 'none2', minute(300)),
        // The same folder as a1 and a2, but other recordings lie between.
        audio(did, 'a-late', minute(360), folderA),
      ])

      const output = await service.getFeed(request({ filter: 'audio' }))

      expect(modelOf(output.feed)).toEqual([
        {
          type: 'audio',
          did,
          deployment: folderA,
          total: 1,
          from: Date.parse(minute(360)),
          to: Date.parse(minute(360)),
          subjects: [`at://${did}/${AUDIO}/a-late`],
          run: 0,
          continued: false,
          capped: false,
        },
        {
          type: 'audio',
          did,
          deployment: null,
          total: 2,
          from: Date.parse(minute(240)),
          to: Date.parse(minute(300)),
          subjects: [
            `at://${did}/${AUDIO}/none2`,
            `at://${did}/${AUDIO}/none1`,
          ],
          run: 1,
          continued: false,
          capped: false,
        },
        {
          type: 'audio',
          did,
          deployment: folderB,
          total: 1,
          from: Date.parse(minute(180)),
          to: Date.parse(minute(180)),
          subjects: [`at://${did}/${AUDIO}/b1`],
          run: 2,
          continued: false,
          capped: false,
        },
        {
          type: 'audio',
          did,
          deployment: folderA,
          total: 2,
          from: Date.parse(minute(60)),
          to: Date.parse(minute(120)),
          subjects: [`at://${did}/${AUDIO}/a2`, `at://${did}/${AUDIO}/a1`],
          run: 3,
          continued: false,
          capped: false,
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

      expect(labels(organizationFeed)).toEqual(['audio(1):member1'])
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
      expect(modelOf(items)).toMatchObject([
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

      expect(modelOf(output.feed)).toMatchObject([
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
      ).toEqual(['audio(2):a2,a1'])
    })

    // The owner of a folder is `audioItem.did` and the folder is
    // `audioItem.deployment`. The Lexicon wants a DID and an AT-URI, and the
    // output check applies both strictly: one value that fails used to answer
    // 500 on every `getFeed` page that held the recording. An authority that is
    // not a valid DID therefore does not become the owner (the recording's own
    // account owns the run), and a folder that is not a valid AT-URI is left
    // out of the item. The recordings group by the folder either way.
    it.each([
      ['an authority with no method or id', 'at://did:/x'],
      ['an authority that ends with a colon', 'at://did:plc:/x'],
      ['an authority that ends with a percent sign', 'at://did:plc:abc%/x'],
      ['a method in capital letters', 'at://did:PLC:abc/x'],
      ['an authority with a query', 'at://did:plc:abc?x=1/y'],
      ['a DID over 2,048 characters', `at://did:web:${'a'.repeat(2_100)}/x`],
    ])(
      "answers 200 on both procedures and names the recording's account, with no folder, for %s",
      async (_reason, folder) => {
        const uploader = randomDid()
        await fixture.seed([
          audio(uploader, 'a1', minute(2), folder),
          post(randomDid(), 'p1', minute(1)),
        ])

        for (const filter of ['audio', 'all']) {
          const feed = await call('getFeed', request({ filter }))
          expect(feed.status, `getFeed ${filter}`).toBe(200)
          const item = $output.schema.$parse(feed.body).feed[0]
          expect(item, filter).toMatchObject({
            $type: 'app.gainforest.feed.defs#audioItem',
            did: uploader,
            total: 1,
          })
          expect(item, filter).not.toHaveProperty('deployment')

          const skeleton = await call('getFeedSkeleton', request({ filter }))
          expect(skeleton.status, `getFeedSkeleton ${filter}`).toBe(200)
          expect(
            $skeletonOutput.schema
              .$parse(skeleton.body)
              .feed.map(({ subject }) => subject),
            filter,
          ).toContain(`at://${uploader}/${AUDIO}/a1`)
        }
      },
    )

    // The owner and the folder are judged apart: a valid DID owns the run even
    // when the rest of the AT-URI is not valid, and then only the folder is
    // left out.
    it.each([
      ['a path that is not a collection and a key', '/x'],
      ['a trailing slash', '/app.gainforest.ac.deployment/f/'],
      ['a query', '/app.gainforest.ac.deployment/f?x=1'],
      ['a fragment', '/app.gainforest.ac.deployment/f#frag'],
    ])(
      'keeps the owner and leaves the folder out for %s',
      async (_reason, path) => {
        const organizationDid = randomDid()
        const uploader = randomDid()
        await fixture.seed([
          audio(uploader, 'a1', minute(1), `at://${organizationDid}${path}`),
        ])

        const { status, body } = await call(
          'getFeed',
          request({ filter: 'audio' }),
        )

        expect(status).toBe(200)
        const item = $output.schema.$parse(body).feed[0]
        expect(item).toMatchObject({ did: organizationDid, total: 1 })
        expect(item).not.toHaveProperty('deployment')
      },
    )

    it('groups the recordings of a folder whose authority is not a DID by the account that stored them', async () => {
      const first = randomDid()
      const other = randomDid()
      const folder = 'at://did:/x'
      await fixture.seed([
        audio(first, 'a1', minute(1), folder),
        audio(first, 'a2', minute(2), folder),
        audio(other, 'b1', minute(3), folder),
      ])

      const items = (await service.getFeed(request({ filter: 'audio' }))).feed

      expect(modelOf(items)).toMatchObject([
        { did: other, total: 1 },
        { did: first, total: 2 },
      ])
    })

    it('takes the owner from any valid DID, whatever its method', async () => {
      const uploader = randomDid()
      const folder =
        'at://did:web:recorders.example.com/app.gainforest.ac.deployment/f'
      await fixture.seed([audio(uploader, 'a1', minute(1), folder)])

      const output = await service.getFeed(request({ filter: 'audio' }))

      expect(output.feed[0]).toMatchObject({
        did: 'did:web:recorders.example.com',
        deployment: folder,
      })
      expect(() => $output.schema.$parse(output)).not.toThrow()
    })

    it('is broken by an interleaved row of another kind, owner, or folder', async () => {
      const did = randomDid()
      const other = randomDid()
      const folder = `at://${did}/app.gainforest.ac.deployment/f`
      const otherFolder = `at://${did}/app.gainforest.ac.deployment/g`
      const othersFolder = `at://${other}/app.gainforest.ac.deployment/h`
      await fixture.seed([
        audio(did, 'a1', minute(1), folder),
        audio(did, 'a2', minute(2), folder),
        post(other, 'between-a', minute(3)),
        audio(did, 'b1', minute(4), folder),
        audio(did, 'b2', minute(5), folder),
        audio(did, 'between-b', minute(6), otherFolder),
        audio(did, 'c1', minute(7), folder),
        audio(did, 'c2', minute(8), folder),
        observation(other, 'between-c', minute(9)),
        audio(did, 'd1', minute(10), folder),
        audio(did, 'd2', minute(11), folder),
        audio(other, 'between-d', minute(12), othersFolder),
        audio(did, 'e1', minute(13), folder),
      ])

      const output = await service.getFeed(request())

      expect(labels(output)).toEqual([
        'audio(1):e1',
        'audio(1):between-d',
        'audio(2):d2,d1',
        'observation:between-c',
        'audio(2):c2,c1',
        'audio(1):between-b',
        'audio(2):b2,b1',
        'post:between-a',
        'audio(2):a2,a1',
      ])
    })

    it('joins recordings exactly 12 hours apart and splits a longer gap', async () => {
      const did = randomDid()
      await fixture.seed([
        audio(did, 'a', minute(0)),
        audio(did, 'b', minute(12 * 60)),
        audio(did, 'c', minute(12 * 60 + 12 * 60)),
        audio(did, 'd', minute(12 * 60 + 12 * 60 + 12 * 60 + 1)),
      ])

      expect(
        labels(await service.getFeed(request({ filter: 'audio' }))),
      ).toEqual(['audio(1):d', 'audio(3):c,b,a'])
    })

    it('is not broken by an interleaved row the active filter excludes', async () => {
      const did = randomDid()
      await fixture.seed([
        audio(did, 'a1', minute(1)),
        post(randomDid(), 'between', minute(2)),
        audio(did, 'a2', minute(3)),
      ])

      expect(
        labels(await service.getFeed(request({ filter: 'audio' }))),
      ).toEqual(['audio(2):a2,a1'])
      expect(labels(await service.getFeed(request()))).toEqual([
        'audio(1):a2',
        'post:between',
        'audio(1):a1',
      ])
    })
  })

  describe('groups longer than the cap', () => {
    const pad = (index: number): string => String(index).padStart(4, '0')

    /** Seeds `count` rows of one run, one second apart, and an older post that ends it. */
    const seedRun = async (
      kind: 'observation' | 'audio',
      count: number,
    ): Promise<{ owner: string; folder: string }> => {
      const owner = randomDid()
      const folder = `at://${owner}/app.gainforest.ac.deployment/run`
      await fixture.seed([
        ...Array.from({ length: count }, (_, index) =>
          kind === 'audio'
            ? audio(owner, `r${pad(index)}`, second(index), folder)
            : observation(owner, `r${pad(index)}`, second(index)),
        ),
        post(randomDid(), 'older', minute(-1_000)),
      ])
      return { owner, folder }
    }

    it('cuts a 1,700-recording run into 9 chunks and carries the run over page boundaries', async () => {
      const { owner } = await seedRun('audio', 1_700)

      const pages = await walk({}, 4)

      const items = pages.flatMap((page) => page.feed)
      expect(flagsOf(items)).toEqual(
        Array.from({ length: 9 }, (_, index) => ({
          type: 'audioItem',
          total: index < 8 ? 200 : 100,
          continued: index > 0,
          capped: index < 8,
        })),
      )
      expect(new Set(chunksOf(items).map((chunk) => chunk.groupKey)).size).toBe(
        1,
      )
      expect(labels({ feed: items.slice(9) })).toEqual(['post:older'])
      expect(pages.map((page) => page.feed.length)).toEqual([4, 4, 2])

      // The first chunk of the second page continues the last chunk of the
      // first page: same key, and the cursor said so.
      const lastOfFirst = pages[0]?.feed.at(-1)
      const firstOfSecond = pages[1]?.feed[0]
      expect(lastOfFirst).toMatchObject({ capped: true, continued: true })
      expect(firstOfSecond).toMatchObject({ continued: true })
      expect(firstOfSecond).toHaveProperty(
        'groupKey',
        lastOfFirst && 'groupKey' in lastOfFirst ? lastOfFirst.groupKey : '',
      )
      expect(
        decodeCursor(ACTIVITY_FEED_ID, pages[0]?.cursor, timestampUriCursor),
      ).toEqual({
        value: expect.any(String) as unknown,
        uri: `at://${owner}/${AUDIO}/r${pad(900)}`,
        group: {
          key:
            lastOfFirst && 'groupKey' in lastOfFirst
              ? lastOfFirst.groupKey
              : '',
          kind: 'audio',
        },
      })
      // The next chunk starts right after the 200 rows of this one.
      expect(items[1]).toMatchObject({
        subjects: Array.from(
          { length: 20 },
          (_, index) => `at://${owner}/${AUDIO}/r${pad(1_499 - index)}`,
        ),
      })
      for (const page of pages) {
        expect(() => $output.schema.$parse(page)).not.toThrow()
      }
    })

    it('gives the same chunks whatever the page size', async () => {
      await seedRun('audio', 1_700)

      const reference = flagsOf(await allItems({}, 50))
      for (const limit of [1, 2, 3, 9, 10]) {
        expect(
          flagsOf(await allItems({}, limit)),
          `limit ${String(limit)}`,
        ).toEqual(reference)
      }
    })

    // The cursor does not carry the owner or the folder: the statement derives
    // them from the cursor row with the expression the audio arm uses. A run
    // must therefore continue across a page boundary whatever shape its owner
    // and folder have, including when the recordings are stored by other
    // accounts than the folder's owner.
    it.each([
      ['a folder owned by another account, stored by two members', 'owned'],
      ['a folder named by handle', 'handle'],
      ['no folder', 'none'],
      ['a folder whose authority is not a DID', 'malformed'],
    ] as const)(
      'continues an audio run across pages for %s',
      async (_name, shape) => {
        const organizationDid = randomDid()
        const uploaders = [randomDid(), randomDid()] as const
        const folder = {
          owned: `at://${organizationDid}/app.gainforest.ac.deployment/f`,
          handle: 'at://recorders.example/app.gainforest.ac.deployment/f',
          none: undefined,
          malformed: 'at://did:/x',
        }[shape]
        // Only a folder owned by another account lets two uploaders share a run.
        const uploaderOf = (index: number): string =>
          shape === 'owned'
            ? (uploaders[index % 2] ?? uploaders[0])
            : uploaders[0]
        await fixture.seed([
          ...Array.from({ length: 8 }, (_, index) =>
            audio(uploaderOf(index), `r${pad(index)}`, second(index), folder),
          ),
          post(randomDid(), 'older', minute(-1_000)),
        ])
        const small = serviceFor(3)

        const items = await allItems({}, 1, small)

        expect(flagsOf(items.slice(0, 3))).toEqual([
          { type: 'audioItem', total: 3, continued: false, capped: true },
          { type: 'audioItem', total: 3, continued: true, capped: true },
          { type: 'audioItem', total: 2, continued: true, capped: false },
        ])
        expect(
          new Set(chunksOf(items).map((chunk) => chunk.groupKey)).size,
        ).toBe(1)
        expect(items[0]).toMatchObject({
          did: shape === 'owned' ? organizationDid : uploaders[0],
        })
      },
    )

    it('cuts a 450-observation burst into chunks of 200, 200, and 50', async () => {
      const { owner } = await seedRun('observation', 450)

      const output = await service.getFeed(request())

      expect(flagsOf(output.feed)).toEqual([
        { type: 'burstItem', total: 200, continued: false, capped: true },
        { type: 'burstItem', total: 200, continued: true, capped: true },
        { type: 'burstItem', total: 50, continued: true, capped: false },
      ])
      expect(modelOf(output.feed.slice(0, 3))).toMatchObject([
        {
          did: owner,
          from: Date.parse(second(250)),
          to: Date.parse(second(449)),
        },
        {
          did: owner,
          from: Date.parse(second(50)),
          to: Date.parse(second(249)),
        },
        { did: owner, from: Date.parse(second(0)), to: Date.parse(second(49)) },
      ])
      expect(output.feed[0]).toMatchObject({
        subjects: Array.from(
          { length: 20 },
          (_, index) => `at://${owner}/${OBSERVATION}/r${pad(449 - index)}`,
        ),
      })
      expect(() => $output.schema.$parse(output)).not.toThrow()
    })

    it.each([
      [199, [{ total: 199, continued: false, capped: false }]],
      [200, [{ total: 200, continued: false, capped: false }]],
      [
        201,
        [
          { total: 200, continued: false, capped: true },
          { total: 1, continued: true, capped: false },
        ],
      ],
    ])(
      'does not cap a run of exactly 200 and cuts one row off a run of 201 (%i observations)',
      async (count, expected) => {
        await seedRun('observation', count)

        const items = (await service.getFeed(request())).feed

        expect(chunksOf(items)).toMatchObject(
          expected.map((chunk) => ({ type: 'burstItem', ...chunk })),
        )
      },
    )

    it('keeps the single row after a full chunk a group chunk, so clients merge it into the run', async () => {
      await seedRun('observation', 201)

      const items = (await service.getFeed(request())).feed

      expect(items.map((item) => item.$type)).toEqual([
        'app.gainforest.feed.defs#burstItem',
        'app.gainforest.feed.defs#burstItem',
        'app.gainforest.feed.defs#recordItem',
      ])
      const [head, rest] = chunksOf(items)
      expect(rest?.groupKey).toBe(head?.groupKey)
    })

    it('treats audio the same way: 200 is one item and 201 is 200 plus 1', async () => {
      await seedRun('audio', 201)

      const items = (await service.getFeed(request())).feed

      expect(flagsOf(items)).toEqual([
        { type: 'audioItem', total: 200, continued: false, capped: true },
        { type: 'audioItem', total: 1, continued: true, capped: false },
      ])
    })

    it.each([
      [12 * 60, true],
      [12 * 60 + 1, false],
    ])(
      'continues a run past a full chunk only when the next row is within 12 hours: %i minutes older, continues %s',
      async (gapMinutes, joins) => {
        const did = randomDid()
        // 200 rows a minute apart, then 50 more after the gap.
        const newest = Array.from({ length: 200 }, (_, index) =>
          observation(did, `new${pad(index)}`, minute(2_000 + index)),
        )
        const older = Array.from({ length: 50 }, (_, index) =>
          observation(
            did,
            `old${pad(index)}`,
            minute(2_000 - gapMinutes - index),
          ),
        )
        await fixture.seed([...newest, ...older])

        const chunks = chunksOf((await service.getFeed(request())).feed)

        expect(chunks.map(({ groupKey: _key, ...chunk }) => chunk)).toEqual([
          { type: 'burstItem', total: 200, continued: false, capped: joins },
          { type: 'burstItem', total: 50, continued: joins, capped: false },
        ])
        expect(chunks[1]?.groupKey === chunks[0]?.groupKey).toBe(joins)
      },
    )

    it.each([
      [60, true],
      [12 * 60, true],
      [12 * 60 + 1, false],
    ])(
      'continues the run a cursor left open only when the next row is within 12 hours of the cursor: %i minutes, continues %s',
      async (gapMinutes, continues) => {
        const did = randomDid()
        // The row the previous page ended at, in the run the cursor names.
        const previous = observation(did, 'previous', minute(5_000))
        await fixture.seed([
          previous,
          ...Array.from({ length: 3 }, (_, index) =>
            observation(
              did,
              `o${String(index)}`,
              minute(5_000 - gapMinutes - index),
            ),
          ),
        ])
        const key = 'AAAAAAAAAAAAAAAAAAAAAA'
        const cursor = encodeCursor(
          ACTIVITY_FEED_ID,
          {
            sortValue: previous.createdAt ?? '',
            uri: uriOf(previous),
            group: { key, kind: 'observation' },
          },
          timestampUriCursor,
        )

        const items = (await service.getFeed(request({ cursor }))).feed

        expect(chunksOf(items)).toMatchObject([
          { total: 3, continued: continues, capped: false },
        ])
        expect(chunksOf(items)[0]?.groupKey === key).toBe(continues)
      },
    )

    it('settles every page in one statement, however long the runs are', async () => {
      const owner = randomDid()
      const folder = `at://${owner}/app.gainforest.ac.deployment/run`
      await fixture.seed([
        ...Array.from({ length: 1_700 }, (_, index) =>
          audio(owner, `r${pad(index)}`, second(index), folder),
        ),
        ...Array.from({ length: 450 }, (_, index) =>
          observation(owner, `o${pad(index)}`, second(-10_000 - index)),
        ),
        ...Array.from({ length: 30 }, (_, index) =>
          post(randomDid(), `p${pad(index)}`, minute(-3_000 - index)),
        ),
      ])
      const counted = countingService()

      for (const limit of [1, 3, 20, 50]) {
        counted.reset()
        const pages = await walk({}, limit, counted.service)
        expect(counted.statements(), `limit ${String(limit)}`).toBe(
          pages.length,
        )
      }
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

    it('rejects a version 1 cursor, which cannot say whether a run continues', async () => {
      const cursor = Buffer.from(
        JSON.stringify({
          version: 1,
          feedId: ACTIVITY_FEED_ID,
          value: { value: minute(1), uri: 'at://did:plc:x/y/z' },
        }),
      ).toString('base64url')

      await expect(service.getFeed(request({ cursor }))).rejects.toMatchObject({
        code: 'InvalidCursor',
        message: expect.stringContaining('version must be 2') as unknown,
      })
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

  describe('cursors', () => {
    const pad = (index: number): string => String(index).padStart(4, '0')

    const cursorOf = (body: unknown): string | undefined => {
      if (typeof body !== 'object' || body === null || !('cursor' in body)) {
        return undefined
      }
      return typeof body.cursor === 'string' ? body.cursor : undefined
    }

    /** Pages one procedure over HTTP to its end, as a client does. */
    const walkHttp = async (
      procedure: 'getFeed' | 'getFeedSkeleton',
      limit: number,
    ): Promise<{ status: number; body: unknown }[]> => {
      const responses: { status: number; body: unknown }[] = []
      let cursor: string | undefined
      do {
        const response = await call(
          procedure,
          request({ limit, ...(cursor === undefined ? {} : { cursor }) }),
        )
        responses.push(response)
        cursor = cursorOf(response.body)
        expect(responses.length).toBeLessThan(50)
      } while (cursor !== undefined)
      return responses
    }

    // What a record stores must not decide how long a cursor is. A folder
    // DID of 1,990 characters is valid (a DID may have 2,048). The cursor
    // once carried it twice, so a page whose last item was a capped chunk of
    // that run had a cursor over the 4,096 characters the response allows and
    // answered 500 for every client.
    it('answers every page of a capped run in a folder with a 1,990-character DID, on both procedures and at every page size', async () => {
      const uploader = randomDid()
      const longDid = `did:web:${'a'.repeat(1_990)}`
      const folder = `at://${longDid}/app.gainforest.ac.deployment/x`
      await fixture.seed([
        ...Array.from({ length: 450 }, (_, index) =>
          audio(uploader, `r${pad(index)}`, second(index), folder),
        ),
        post(randomDid(), 'older', minute(-1_000)),
      ])

      for (const procedure of ['getFeed', 'getFeedSkeleton'] as const) {
        for (const limit of [1, 2, 3, 50]) {
          const responses = await walkHttp(procedure, limit)

          const context = `${procedure}, limit ${String(limit)}`
          expect(
            responses.map(({ status }) => status),
            context,
          ).toEqual(responses.map(() => 200))
          for (const { body } of responses) {
            expect(cursorOf(body)?.length ?? 0, context).toBeLessThan(1_000)
          }
        }
      }

      const pages = await walk({}, 1)
      expect(flagsOf(pages.flatMap((page) => page.feed))).toEqual([
        { type: 'audioItem', total: 200, continued: false, capped: true },
        { type: 'audioItem', total: 200, continued: true, capped: true },
        { type: 'audioItem', total: 50, continued: true, capped: false },
      ])
      expect(pages[0]?.feed[0]).toMatchObject({ did: longDid })
    })

    it('names only the key and the kind of the run it leaves open', async () => {
      const did = randomDid()
      await fixture.seed(
        Array.from({ length: 450 }, (_, index) =>
          audio(
            did,
            `r${pad(index)}`,
            second(index),
            `at://${did}/app.gainforest.ac.deployment/f`,
          ),
        ),
      )

      const page = await service.getFeed(request({ limit: 1 }))

      const decoded = decodeCursor(
        ACTIVITY_FEED_ID,
        page.cursor,
        timestampUriCursor,
      )
      expect(Object.keys(decoded?.group ?? {}).sort()).toEqual(['key', 'kind'])
    })

    describe.each(['audio', 'observation'] as const)(
      'a cursor that names an open %s run',
      (kind) => {
        const KEY = 'AAAAAAAAAAAAAAAAAAAAAA'

        /**
         * Five rows one second apart, newest r4, and an older post. The cursor
         * row is r3, so the page after it starts with r2, r1, r0. The older
         * rows can sit in another folder (audio) or belong to another account
         * (observations), and an audio run can have no folder at all.
         */
        const seedRun = async (
          options: {
            readonly cursorRow?: Partial<SeedRecord>
            readonly olderElsewhere?: boolean
            readonly folderless?: boolean
          } = {},
        ) => {
          const owner = randomDid()
          const elsewhere = randomDid()
          const folder = `at://${owner}/app.gainforest.ac.deployment/f`
          const otherFolder = `at://${elsewhere}/app.gainforest.ac.deployment/g`
          const rows = Array.from({ length: 5 }, (_, index) => {
            const older = index < 3 && options.olderElsewhere === true
            const row =
              kind === 'audio'
                ? audio(
                    owner,
                    `r${String(index)}`,
                    second(index),
                    options.folderless === true
                      ? undefined
                      : older
                        ? otherFolder
                        : folder,
                  )
                : observation(
                    older ? elsewhere : owner,
                    `r${String(index)}`,
                    second(index),
                  )
            return { ...row, ...(index === 3 ? options.cursorRow : {}) }
          })
          await fixture.seed([
            ...rows,
            post(randomDid(), 'older', minute(-1_000)),
          ])
          const cursorRow = rows[3]
          if (cursorRow === undefined) throw new Error('seedRun makes 5 rows')
          return { owner, cursorRow }
        }

        /**
         * A cursor a client could make by hand: the payload is written as
         * JSON, not through the codec, so the group can have any shape.
         */
        const cursorFor = (
          row: SeedRecord,
          group: unknown,
          overrides: { sortValue?: string; uri?: string } = {},
        ): string =>
          Buffer.from(
            JSON.stringify({
              version: 2,
              feedId: ACTIVITY_FEED_ID,
              value: {
                value: overrides.sortValue ?? row.createdAt ?? '',
                uri: overrides.uri ?? uriOf(row),
                group,
              },
            }),
          ).toString('base64url')

        const group = { key: KEY, kind }

        /** The first chunk the page after the cursor returns. */
        const firstChunk = async (cursor: string) =>
          chunksOf((await service.getFeed(request({ cursor }))).feed)[0]

        it('continues the run when the cursor row is still in it', async () => {
          const { cursorRow } = await seedRun()

          const chunk = await firstChunk(cursorFor(cursorRow, group))

          expect(chunk).toMatchObject({
            total: 3,
            continued: true,
            capped: false,
            groupKey: KEY,
          })
        })

        it('does not continue it when the next row is of another account or folder, which the database says, not the cursor', async () => {
          const { cursorRow } = await seedRun({ olderElsewhere: true })

          const chunk = await firstChunk(cursorFor(cursorRow, group))

          expect(chunk).toMatchObject({ total: 3, continued: false })
          expect(chunk?.groupKey).not.toBe(KEY)
        })

        it('does not continue it for the other kind', async () => {
          const { cursorRow } = await seedRun()
          const other = kind === 'audio' ? 'observation' : 'audio'

          const chunk = await firstChunk(
            cursorFor(cursorRow, { key: KEY, kind: other }),
          )

          expect(chunk).toMatchObject({ total: 3, continued: false })
          expect(chunk?.groupKey).not.toBe(KEY)
        })

        it('does not continue it when the cursor row is gone', async () => {
          const { cursorRow } = await seedRun()
          // The same account and collection, and a key that sorts before r3,
          // so that the page starts at the same row as with the real cursor.
          const uri = uriOf({ ...cursorRow, rkey: 'a-gone' })

          const chunk = await firstChunk(cursorFor(cursorRow, group, { uri }))

          expect(chunk).toMatchObject({ total: 3, continued: false })
          expect(chunk?.groupKey).not.toBe(KEY)
        })

        it('does not continue it when the cursor row has another timestamp than the cursor says', async () => {
          const { cursorRow } = await seedRun()
          // Half a second later than the row: the page starts at the row itself.
          const sortValue = new Date(BASE + 3_500).toISOString()

          const chunk = await firstChunk(
            cursorFor(cursorRow, group, { sortValue }),
          )

          expect(chunk).toMatchObject({ total: 4, continued: false })
          expect(chunk?.groupKey).not.toBe(KEY)
        })

        it('does not continue it when the cursor row is not valid', async () => {
          const { cursorRow } = await seedRun({
            cursorRow: { validation: 'invalid' },
          })

          const chunk = await firstChunk(cursorFor(cursorRow, group))

          expect(chunk).toMatchObject({ total: 3, continued: false })
        })

        // An account's rows of another kind look like the run to a lookup that
        // does not check the collection: a folderless recording and an
        // observation of the same account have the same key, for one.
        it('does not continue it when the cursor row is a record of another kind by the same account', async () => {
          const { owner } = await seedRun({ folderless: true })
          // Between r4 and r3: the page starts at r3 and has to say no.
          const between =
            kind === 'audio'
              ? observation(owner, 'between', second(3.5))
              : post(owner, 'between', second(3.5))
          await fixture.seed([between])

          const chunk = await firstChunk(cursorFor(between, group))

          expect(chunk).toMatchObject({ total: 4, continued: false })
          expect(chunk?.groupKey).not.toBe(KEY)
        })

        it('is rejected when it names an account or a folder, which only the database may say', async () => {
          const { owner, cursorRow } = await seedRun()
          const cursor = cursorFor(cursorRow, {
            ...group,
            did: owner,
            folder: `at://${owner}/app.gainforest.ac.deployment/f`,
          })

          for (const procedure of ['getFeed', 'getFeedSkeleton'] as const) {
            const { status, body } = await call(procedure, request({ cursor }))

            expect(status, procedure).toBe(400)
            expect(body, procedure).toMatchObject({ error: 'InvalidCursor' })
          }
        })
      },
    )

    // PostgreSQL rejects these timestamps although they look like RFC 3339
    // datetimes, and the statement used to answer 500.
    it.each([
      ['a day the month does not have', '2026-02-30T00:00:00Z'],
      ['year 0000', '0000-01-01T00:00:00Z'],
      ['a UTC offset of 16:00', '2026-01-01T00:00:00+16:00'],
    ])(
      'answers 400 InvalidCursor for a timestamp with %s',
      async (_name, sortValue) => {
        const cursor = encodeCursor(
          ACTIVITY_FEED_ID,
          { sortValue, uri: `at://${randomDid()}/${POST}/x` },
          timestampUriCursor,
        )

        for (const procedure of ['getFeed', 'getFeedSkeleton'] as const) {
          const { status, body } = await call(procedure, request({ cursor }))

          expect(status, procedure).toBe(400)
          expect(body, procedure).toMatchObject({ error: 'InvalidCursor' })
        }
      },
    )

    // The other half of the check: whatever the cursor check lets through,
    // PostgreSQL has to take.
    it.each([
      '2024-02-29T12:00:00.123456Z',
      '0001-01-01T00:00:00Z',
      '9999-12-31T23:59:59.999999Z',
      '2026-01-01T00:00:00+15:59',
      '2026-01-01T00:00:00-15:59',
      '2026-01-01T00:00:00.1234567890123Z',
    ])('answers 200 for the timestamp %s', async (sortValue) => {
      await fixture.seed([post(randomDid(), 'p1', minute(1))])
      const cursor = encodeCursor(
        ACTIVITY_FEED_ID,
        { sortValue, uri: `at://${randomDid()}/${POST}/x` },
        timestampUriCursor,
      )

      for (const procedure of ['getFeed', 'getFeedSkeleton'] as const) {
        const { status } = await call(procedure, request({ cursor }))

        expect(status, procedure).toBe(200)
      }
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

    it('flattens the chunks of a long run into their samples and shares the cursor', async () => {
      const did = randomDid()
      await fixture.seed([
        ...Array.from({ length: 450 }, (_, index) =>
          observation(did, `o${String(index).padStart(3, '0')}`, second(index)),
        ),
        post(randomDid(), 'older', minute(-1_000)),
      ])

      const full = await service.getFeed(request({ limit: 2 }))
      const skeleton = await service.getFeedSkeleton(request({ limit: 2 }))

      expect(skeleton.cursor).toBeDefined()
      expect(skeleton.cursor).toBe(full.cursor)
      // Two chunks of 200 rows contribute their 20 newest rows each.
      expect(skeleton.feed.map(({ subject }) => rkeyOf(subject))).toEqual([
        ...Array.from(
          { length: 20 },
          (_, index) => `o${String(449 - index).padStart(3, '0')}`,
        ),
        ...Array.from(
          { length: 20 },
          (_, index) => `o${String(249 - index).padStart(3, '0')}`,
        ),
      ])
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
        // A DID of another method owns its folder in the same way.
        'at://did:web:recorders.example/app.gainforest.ac.deployment/f4',
        // So does nothing that only starts like a DID.
        'at://did:/app.gainforest.ac.deployment/f5',
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

      // Rows often repeat the previous row's account and kind, so the data has
      // runs long enough to be cut by a small cap.
      let lastDid = pick(dids)
      let lastRoll = next()
      let lastFolder = pick(folders)
      for (let step = 0; step < 260; step += 1) {
        const sticky = next() < 0.6
        const did = sticky ? lastDid : pick(dids)
        const roll = sticky ? lastRoll : next()
        lastDid = did
        lastRoll = roll
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
          lastFolder = next() < 0.7 ? lastFolder : pick(folders)
          records.push({
            ...audio(did, key(), createdAt, lastFolder),
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
      maxGroupRows: number | undefined,
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
          ...(maxGroupRows === undefined ? {} : { maxGroupRows }),
          ...(scope === undefined ? {} : { followed: scope.followed }),
        })
        for (const limit of [1, 2, 3, 7, 20, 50]) {
          const actual = modelOf(
            await allItems(
              {
                filter,
                ...(scope === undefined
                  ? {}
                  : { following: true, viewerDid: scope.viewer }),
              },
              limit,
              reader,
            ),
          )
          expect(actual, `filter ${filter}, limit ${String(limit)}`).toEqual(
            expected,
          )
        }
      }
    }

    it('has runs long enough for the small caps to cut, so the comparisons cover continued and capped chunks', () => {
      const chunks = modelFeed(randomDataset(1, true), {
        filter: 'all',
        maxGroupRows: 3,
      }).filter((item) => item.type === 'burst' || item.type === 'audio')

      for (const type of ['burst', 'audio']) {
        const ofType = chunks.filter((item) => item.type === type)
        expect(
          ofType.some((item) => item.continued),
          type,
        ).toBe(true)
        expect(
          ofType.some((item) => item.capped),
          type,
        ).toBe(true)
      }
    })

    const configurations = [
      {
        name: 'production cap, unique timestamps',
        ties: false,
        cap: undefined,
        seeds: [1, 2, 3, 4],
      },
      {
        name: 'production cap, tied timestamps',
        ties: true,
        cap: undefined,
        seeds: [1, 2],
      },
      {
        name: 'cap of 2 rows, unique timestamps',
        ties: false,
        cap: 2,
        seeds: [1, 2, 3],
      },
      {
        name: 'cap of 3 rows, tied timestamps',
        ties: true,
        cap: 3,
        seeds: [1, 2, 3],
      },
      {
        name: 'cap of 5 rows, unique timestamps',
        ties: false,
        cap: 5,
        seeds: [1, 2],
      },
      {
        name: 'cap of 4 rows, tied timestamps',
        ties: true,
        cap: 4,
        seeds: [1],
      },
    ] as const

    describe.each(configurations)('$name', (configuration) => {
      const reader = (): FeedService =>
        configuration.cap === undefined
          ? service
          : serviceFor(configuration.cap)

      it.each(configuration.seeds)(
        'pages random dataset %i exactly like the model for every filter and page size',
        async (seed) => {
          const records = randomDataset(seed, configuration.ties)
          await fixture.seed(records)

          await expectModelFeed(records, reader(), configuration.cap)
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

        await expectModelFeed(records, reader(), configuration.cap, {
          viewer,
          followed,
        })
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

  // The feed statement is a 10 ms query whose estimated cost grows with the
  // table: above `jit_above_cost` PostgreSQL would compile it and add
  // 100 to 150 ms to every page. The pool has to get the setting to the server.
  it('opens every session with JIT off', async () => {
    const { rows } = await database.query<{ jit: string; read_only: string }>(
      `SELECT current_setting('jit') AS jit,
              current_setting('default_transaction_read_only') AS read_only`,
    )

    expect(rows).toEqual([{ jit: 'off', read_only: 'on' }])
  })
})
