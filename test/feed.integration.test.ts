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
import {
  BATCH_ROWS,
  REQUEST_ROWS,
  createActivityFeed,
  type ActivityFeedOptions,
} from '../src/feed/query.js'
import { FeedRegistry } from '../src/feed/registry.js'
import { FeedService } from '../src/feed/service.js'
import {
  ACTIVITY_FEED_ID,
  ACTIVITY_FEED_PARAMS_TYPE,
  type ActivityFeedItem,
  type FeedRequest,
  type GetFeedOutput,
  type GroupItem,
} from '../src/feed/types.js'
import { $output } from '../src/lexicons/app/gainforest/feed/getFeed.js'
import { $output as $skeletonOutput } from '../src/lexicons/app/gainforest/feed/getFeedSkeleton.js'
import { Metrics } from '../src/metrics.js'
import {
  modelPages,
  modelRowUris,
  type ModelItem,
} from './support/feed-model.js'
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
 * One recorder's dump: `count` recordings `gapSeconds` apart, the newest
 * `endSeconds` after the fixture epoch, all in one folder of their owner.
 */
const dumpOf = (
  name: string,
  count: number,
  gapSeconds: number,
  endSeconds: number,
): { owner: string; folder: string; records: SeedRecord[] } => {
  const owner = randomDid()
  const folder = `at://${owner}/app.gainforest.ac.deployment/${name}`
  return {
    owner,
    folder,
    records: Array.from({ length: count }, (_, index) =>
      audio(
        owner,
        `${name}${String(index).padStart(5, '0')}`,
        second(endSeconds - (count - 1 - index) * gapSeconds),
        folder,
      ),
    ),
  }
}

/** The model's form of a recording that is shown as a record. */
const audioRecordOf = (
  did: string,
  rkey: string,
  createdAt: string,
): ModelItem => ({
  type: 'record',
  kind: 'audio',
  uri: `at://${did}/${AUDIO}/${rkey}`,
  did,
  at: Date.parse(createdAt),
})

/**
 * A compact, comparable form of service items. Group keys become group indexes
 * in order of appearance on the page, so items of one group compare equal to
 * the model's.
 */
const modelOf = (items: readonly ActivityFeedItem[]): ModelItem[] => {
  const groupIndexes = new Map<string, number>()
  const groupIndexOf = (groupKey: string): number => {
    const known = groupIndexes.get(groupKey)
    if (known !== undefined) return known
    groupIndexes.set(groupKey, groupIndexes.size)
    return groupIndexes.size - 1
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
      case 'app.gainforest.feed.defs#groupItem':
        return {
          type: 'group',
          kind: item.kind,
          did: item.did,
          deployment: item.deployment ?? null,
          total: item.total,
          from: Date.parse(item.from),
          to: Date.parse(item.to),
          subjects: item.subjects,
          groupIndex: groupIndexOf(item.groupKey),
          more: item.more ?? false,
        }
    }
  })
}

/** Short labels for readable assertions: `observation:o1`, `observation(3):o3,o2,o1`, … */
const label = (item: ActivityFeedItem): string => {
  switch (item.$type) {
    case 'app.gainforest.feed.defs#recordItem':
      return `${item.kind}:${rkeyOf(item.uri)}`
    case 'app.gainforest.feed.defs#repostItem':
      return `repost:${rkeyOf(item.uri)}`
    case 'app.gainforest.feed.defs#groupItem':
      return `${item.kind}(${String(item.total)}):${item.subjects.map(rkeyOf).join(',')}`
  }
}

/** The group items of a page, in feed order. */
const groupsOf = (items: readonly ActivityFeedItem[]): GroupItem[] =>
  items.flatMap((item) =>
    item.$type === 'app.gainforest.feed.defs#groupItem' ? [item] : [],
  )

/**
 * The merge a client applies to cards of later pages, as the Lexicon and the
 * README document it: keep the last card shown for each groupKey, and merge a
 * later card with the same groupKey into it when its `to` is no more than 12
 * hours before that card's `from`. Returns the merged cards in feed order.
 */
const mergeGroups = (
  pages: readonly GetFeedOutput[],
): { groupKey: string; total: number; from: string; more: boolean }[] => {
  const cards: {
    groupKey: string
    total: number
    from: string
    more: boolean
  }[] = []
  const last = new Map<string, (typeof cards)[number]>()
  for (const group of groupsOf(pages.flatMap((page) => page.feed))) {
    const shown = last.get(group.groupKey)
    if (
      shown !== undefined &&
      Date.parse(shown.from) - Date.parse(group.to) <= 12 * 3_600_000
    ) {
      shown.total += group.total
      shown.from = group.from
      shown.more = group.more ?? false
    } else {
      const card = {
        groupKey: group.groupKey,
        total: group.total,
        from: group.from,
        more: group.more ?? false,
      }
      cards.push(card)
      last.set(group.groupKey, card)
    }
  }
  return cards
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

  /** A feed service over the fixture, optionally with small batch and budget sizes. */
  const serviceFor = (options: ActivityFeedOptions = {}): FeedService =>
    new FeedService(
      new FeedRegistry([
        createActivityFeed({ database: fixture.database, metrics }, options),
      ]),
    )

  /** A feed service that records the statements it sends to the database. */
  const countingService = (options: ActivityFeedOptions = {}) => {
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
          options,
        ),
      ]),
    )
    return {
      service: counted,
      statements: () => sent.length,
      reset: () => {
        sent = []
      },
    }
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
      readonly limit?: number
      readonly cursor?: string
    } = {},
  ): FeedRequest => ({
    feedId: ACTIVITY_FEED_ID,
    params: {
      $type: ACTIVITY_FEED_PARAMS_TYPE,
      ...(options.filter === undefined ? {} : { filter: options.filter }),
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

  /** Pages through the whole feed and counts the statements each request sent. */
  const walkCounted = async (
    counted: ReturnType<typeof countingService>,
    options: Parameters<typeof request>[0] = {},
    limit = 50,
  ): Promise<{ pages: GetFeedOutput[]; statements: number[] }> => {
    const pages: GetFeedOutput[] = []
    const statements: number[] = []
    let cursor: string | undefined
    do {
      counted.reset()
      const page = await counted.service.getFeed(
        request({
          ...options,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      )
      pages.push(page)
      statements.push(counted.statements())
      cursor = page.cursor
      expect(pages.length).toBeLessThan(500)
    } while (cursor !== undefined)
    return { pages, statements }
  }

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

    it('limits the audio filter to recordings', async () => {
      const did = randomDid()
      await fixture.seed([
        observation(did, 'o1', minute(40)),
        audio(did, 'a1', minute(50)),
      ])

      expect(
        labels(await service.getFeed(request({ filter: 'audio' }))),
      ).toEqual(['audio:a1'])
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
        'audio:good-audio',
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

      expect(labels(omitted)).toEqual(['audio:a1', 'post:p1', 'observation:o1'])
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
        'audio:a1',
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
      const recent = (rkey: string, minutesAgo: number): SeedRecord =>
        audio(
          did,
          rkey,
          new Date(now - minutesAgo * 60_000).toISOString(),
          folder,
        )
      await fixture.seed([
        recent('recent1', 30),
        recent('recent2', 20),
        recent('recent3', 10),
        audio(did, 'ahead', new Date(now + 3_600_000).toISOString(), folder),
        audio(did, 'far-future', '2099-06-01T00:00:00.000Z', folder),
        audio(did, 'year-10000', '10000-01-01T04:59:59Z', folder),
      ])

      const items = (await service.getFeed(request({ filter: 'audio' }))).feed

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        total: 3,
        subjects: ['recent3', 'recent2', 'recent1'].map(
          (rkey) => `at://${did}/${AUDIO}/${rkey}`,
        ),
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

  describe('params the feed does not define', () => {
    // If following were honoured, a viewer who follows one account would see
    // only that account's records. Every caller gets the same feed instead.
    it('ignores following and viewerDid: the same feed on both procedures for every caller', async () => {
      const viewer = randomDid()
      const followed = randomDid()
      const stranger = randomDid()
      await fixture.seed([
        follow(viewer, followed),
        post(followed, 'p1', minute(1)),
        post(stranger, 'p2', minute(2)),
        observation(stranger, 'o1', minute(3)),
        audio(stranger, 'a1', minute(4)),
      ])

      /** The request body as a client sends it, with whatever else it adds to the params. */
      const send = async (
        procedure: 'getFeed' | 'getFeedSkeleton',
        extra: Record<string, unknown>,
      ): Promise<{ status: number; body: unknown }> => {
        const response = await appFor(service).fetch(
          postJson(`app.gainforest.feed.${procedure}`, {
            feedId: ACTIVITY_FEED_ID,
            params: { $type: ACTIVITY_FEED_PARAMS_TYPE, ...extra },
          }),
        )
        return {
          status: response.status,
          body: (await response.json()) as unknown,
        }
      }

      for (const procedure of ['getFeed', 'getFeedSkeleton'] as const) {
        const global = await send(procedure, {})
        expect(global.status).toBe(200)

        for (const extra of [
          { following: true, viewerDid: viewer },
          { following: true },
          { following: 'yes', viewerDid: 'alice.test' },
        ]) {
          expect(
            await send(procedure, extra),
            `${procedure} with ${JSON.stringify(extra)}`,
          ).toEqual(global)
        }
      }
      expect(labels(await service.getFeed(request()))).toEqual([
        'audio:a1',
        'observation:o1',
        'post:p2',
        'post:p1',
      ])
    })
  })

  describe('observation groups', () => {
    it('folds three observations of one account into one group with exact counts', async () => {
      const did = randomDid()
      await fixture.seed([
        observation(did, 'o1', minute(1)),
        observation(did, 'o2', minute(2)),
        observation(did, 'o3', minute(3)),
      ])

      const output = await service.getFeed(request())

      expect(output.feed).toEqual([
        {
          $type: 'app.gainforest.feed.defs#groupItem',
          kind: 'observation',
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
        },
      ])
      expect(() => $output.schema.$parse(output)).not.toThrow()
    })

    it('shows one or two observations of an account as separate records', async () => {
      const did = randomDid()
      const other = randomDid()
      await fixture.seed([
        observation(did, 'o1', minute(1)),
        observation(other, 'x1', minute(2)),
        observation(did, 'o2', minute(3)),
      ])

      expect(labels(await service.getFeed(request()))).toEqual([
        'observation:o2',
        'observation:x1',
        'observation:o1',
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
        'observation(3):c,b,a',
      ])
    })

    it('is not broken by interleaved rows of another kind or another account', async () => {
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
        'observation(6):c2,c1,b2,b1,a2,a1',
        'observation:between-b',
        'post:between-a',
      ])
    })

    it('groups the same observations whether or not the filter keeps the rows between them', async () => {
      const did = randomDid()
      await fixture.seed([
        observation(did, 'a1', minute(1)),
        post(randomDid(), 'between', minute(2)),
        observation(did, 'a2', minute(3)),
        observation(did, 'a3', minute(4)),
      ])

      expect(
        labels(await service.getFeed(request({ filter: 'observation' }))),
      ).toEqual(['observation(3):a3,a2,a1'])
      expect(labels(await service.getFeed(request()))).toEqual([
        'observation(3):a3,a2,a1',
        'post:between',
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
        $type: 'app.gainforest.feed.defs#groupItem',
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

    it('keeps sightings with a valid bioacoustic sidecar out of groups', async () => {
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
        'observation(6):photo6,photo5,photo4,photo3,photo2,photo1',
        'observation:sound1',
      ])
    })

    it('shows bioacoustic sightings one by one however many an account has', async () => {
      const did = randomDid()
      const source = `at://${did}/${AUDIO}/src`
      const sound = (rkey: string, at: string): SeedRecord =>
        observation(did, rkey, at, {
          dynamicProperties: JSON.stringify({
            gainforestBioacoustics: {
              version: 1,
              sourceAudioUri: source,
              labelCategory: 'frog',
              startTimeSeconds: 1,
              endTimeSeconds: 2,
              minFrequencyHz: 100,
              maxFrequencyHz: 9000,
            },
          }),
          associatedMedia: source,
        })
      await fixture.seed([
        sound('s1', minute(1)),
        sound('s2', minute(2)),
        sound('s3', minute(3)),
        sound('s4', minute(4)),
      ])

      expect(labels(await service.getFeed(request()))).toEqual([
        'observation:s4',
        'observation:s3',
        'observation:s2',
        'observation:s1',
      ])
    })
  })

  describe('rows that never group', () => {
    it('shows reposts, posts, projects, and organizations one by one, whoever stores them', async () => {
      const author = randomDid()
      const reposter = randomDid()
      const originals = Array.from({ length: 4 }, (_, index) =>
        post(author, `p${String(index)}`, minute(index + 1)),
      )
      await fixture.seed([
        ...originals,
        ...originals.map((original, index) =>
          repost(reposter, `r${String(index)}`, minute(10 + index), original),
        ),
        project(author, 'c1', minute(20)),
        project(author, 'c2', minute(21)),
        project(author, 'c3', minute(22)),
        organization(author, minute(23)),
      ])

      expect(labels(await service.getFeed(request()))).toEqual([
        'organization:self',
        'project:c3',
        'project:c2',
        'project:c1',
        'repost:r3',
        'repost:r2',
        'repost:r1',
        'repost:r0',
        'post:p3',
        'post:p2',
        'post:p1',
        'post:p0',
      ])
    })
  })

  describe('audio groups', () => {
    it('groups recordings by owner and recorder folder, whatever lies between them', async () => {
      const did = randomDid()
      const folderA = `at://${did}/app.gainforest.ac.deployment/a`
      const folderB = `at://${did}/app.gainforest.ac.deployment/b`
      await fixture.seed([
        audio(did, 'a1', minute(60), folderA),
        audio(did, 'a2', minute(120), folderA),
        audio(did, 'b1', minute(180), folderB),
        audio(did, 'none1', minute(240)),
        audio(did, 'none2', minute(300)),
        audio(did, 'a-late', minute(360), folderA),
      ])

      const output = await service.getFeed(request({ filter: 'audio' }))

      expect(modelOf(output.feed)).toEqual([
        {
          type: 'group',
          kind: 'audio',
          did,
          deployment: folderA,
          total: 3,
          from: Date.parse(minute(60)),
          to: Date.parse(minute(360)),
          subjects: [
            `at://${did}/${AUDIO}/a-late`,
            `at://${did}/${AUDIO}/a2`,
            `at://${did}/${AUDIO}/a1`,
          ],
          groupIndex: 0,
          more: false,
        },
        audioRecordOf(did, 'none2', minute(300)),
        audioRecordOf(did, 'none1', minute(240)),
        audioRecordOf(did, 'b1', minute(180)),
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
        $type: 'app.gainforest.feed.defs#groupItem',
        kind: 'audio',
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

    it('groups recordings without a folder by their own account', async () => {
      const first = randomDid()
      const second = randomDid()
      await fixture.seed([
        audio(first, 'a1', minute(1)),
        audio(first, 'a2', minute(2)),
        audio(second, 'b1', minute(3)),
        audio(first, 'a3', minute(4)),
      ])

      const items = (await service.getFeed(request({ filter: 'audio' }))).feed

      expect(labels({ feed: items })).toEqual(['audio(3):a3,a2,a1', 'audio:b1'])
      expect(groupsOf(items)[0]).toMatchObject({ did: first })
      expect(groupsOf(items)[0]).not.toHaveProperty('deployment')
    })

    it("falls back to the recording's account when the folder's authority is not a DID", async () => {
      const first = randomDid()
      const second = randomDid()
      const folder = 'at://alice.example/app.gainforest.ac.deployment/f'
      await fixture.seed([
        ...['a1', 'a2', 'a3'].map((rkey, index) =>
          audio(first, rkey, minute(index + 1), folder),
        ),
        ...['b1', 'b2', 'b3'].map((rkey, index) =>
          audio(second, rkey, minute(index + 4), folder),
        ),
      ])

      const output = await service.getFeed(request({ filter: 'audio' }))

      expect(modelOf(output.feed)).toMatchObject([
        { did: second, deployment: folder, total: 3 },
        { did: first, deployment: folder, total: 3 },
      ])
      expect(() => $output.schema.$parse(output)).not.toThrow()
    })

    it('treats a deployment reference that is not an AT-URI as no folder', async () => {
      const did = randomDid()
      await fixture.seed([
        audio(did, 'a1', minute(1), 'not-a-uri'),
        audio(did, 'a2', minute(2)),
        audio(did, 'a3', minute(3)),
      ])

      const output = await service.getFeed(request({ filter: 'audio' }))

      expect(labels(output)).toEqual(['audio(3):a3,a2,a1'])
      expect(output.feed[0]).not.toHaveProperty('deployment')
    })

    // The owner of a folder is `groupItem.did` and the folder is
    // `groupItem.deployment`. The Lexicon wants a DID and an AT-URI, and the
    // output check applies both strictly: one value that fails used to answer
    // 500 on every `getFeed` page that held the recording. An authority that is
    // not a valid DID therefore does not become the owner (the recording's own
    // account owns the group), and a folder that is not a valid AT-URI is left
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
          audio(uploader, 'a2', minute(3), folder),
          audio(uploader, 'a3', minute(4), folder),
          post(randomDid(), 'p1', minute(1)),
        ])

        for (const filter of ['audio', 'all']) {
          const feed = await call('getFeed', request({ filter }))
          expect(feed.status, `getFeed ${filter}`).toBe(200)
          const item = $output.schema.$parse(feed.body).feed[0]
          expect(item, filter).toMatchObject({
            $type: 'app.gainforest.feed.defs#groupItem',
            kind: 'audio',
            did: uploader,
            total: 3,
          })
          expect(item, filter).not.toHaveProperty('deployment')

          const skeleton = await call('getFeedSkeleton', request({ filter }))
          expect(skeleton.status, `getFeedSkeleton ${filter}`).toBe(200)
          expect(
            $skeletonOutput.schema
              .$parse(skeleton.body)
              .feed.map(({ subject }) => subject),
            filter,
          ).toEqual(
            expect.arrayContaining(
              ['a1', 'a2', 'a3'].map(
                (rkey) => `at://${uploader}/${AUDIO}/${rkey}`,
              ),
            ),
          )
        }
      },
    )

    // The owner and the folder are judged apart: a valid DID owns the group
    // even when the rest of the AT-URI is not valid, and then only the folder
    // is left out.
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
        const folder = `at://${organizationDid}${path}`
        await fixture.seed(
          ['a1', 'a2', 'a3'].map((rkey, index) =>
            audio(uploader, rkey, minute(index + 1), folder),
          ),
        )

        const { status, body } = await call(
          'getFeed',
          request({ filter: 'audio' }),
        )

        expect(status).toBe(200)
        const item = $output.schema.$parse(body).feed[0]
        expect(item).toMatchObject({ did: organizationDid, total: 3 })
        expect(item).not.toHaveProperty('deployment')
      },
    )

    it('groups the recordings of a folder whose authority is not a DID by the account that stored them', async () => {
      const first = randomDid()
      const other = randomDid()
      const folder = 'at://did:/x'
      await fixture.seed([
        ...['a1', 'a2', 'a3'].map((rkey, index) =>
          audio(first, rkey, minute(index + 1), folder),
        ),
        ...['b1', 'b2', 'b3'].map((rkey, index) =>
          audio(other, rkey, minute(index + 4), folder),
        ),
      ])

      const items = (await service.getFeed(request({ filter: 'audio' }))).feed

      expect(modelOf(items)).toMatchObject([
        { did: other, total: 3 },
        { did: first, total: 3 },
      ])
    })

    it('takes the owner from any valid DID, whatever its method', async () => {
      const uploader = randomDid()
      const folder =
        'at://did:web:recorders.example.com/app.gainforest.ac.deployment/f'
      await fixture.seed(
        ['a1', 'a2', 'a3'].map((rkey, index) =>
          audio(uploader, rkey, minute(index + 1), folder),
        ),
      )

      const output = await service.getFeed(request({ filter: 'audio' }))

      expect(output.feed[0]).toMatchObject({
        did: 'did:web:recorders.example.com',
        deployment: folder,
      })
      expect(() => $output.schema.$parse(output)).not.toThrow()
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
      ).toEqual(['audio:d', 'audio(3):c,b,a'])
    })

    it('is not broken by an interleaved row of another kind, owner, or folder', async () => {
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
        'audio(9):e1,d2,d1,c2,c1,b2,b1,a2,a1',
        'audio:between-d',
        'observation:between-c',
        'audio:between-b',
        'post:between-a',
      ])
    })

    it('groups the same recordings whether or not the filter keeps the rows between them', async () => {
      const did = randomDid()
      await fixture.seed([
        audio(did, 'a1', minute(1)),
        post(randomDid(), 'between', minute(2)),
        audio(did, 'a2', minute(3)),
        audio(did, 'a3', minute(4)),
      ])

      expect(
        labels(await service.getFeed(request({ filter: 'audio' }))),
      ).toEqual(['audio(3):a3,a2,a1'])
      expect(labels(await service.getFeed(request()))).toEqual([
        'audio(3):a3,a2,a1',
        'post:between',
      ])
    })
  })

  describe('interleaved uploads', () => {
    it('gives two recorders that upload at the same time one card each, not many short ones', async () => {
      const first = dumpOf('first', 30, 3, 1_000)
      const other = dumpOf('other', 25, 4, 1_001)
      await fixture.seed([...first.records, ...other.records])

      const output = await service.getFeed(request())

      expect(modelOf(output.feed)).toMatchObject([
        { type: 'group', did: other.owner, total: 25, groupIndex: 0 },
        { type: 'group', did: first.owner, total: 30, groupIndex: 1 },
      ])
      expect(new Set(groupsOf(output.feed).map((g) => g.groupKey)).size).toBe(2)
    })

    it('gives the sightings of one account inside an audio dump one observation card', async () => {
      const first = dumpOf('first', 60, 3, 1_000)
      const other = dumpOf('other', 50, 4, 1_001)
      const citizen = randomDid()
      await fixture.seed([
        ...first.records,
        ...other.records,
        ...Array.from({ length: 8 }, (_, index) =>
          observation(citizen, `o${String(index)}`, second(900 - index * 20)),
        ),
        // A day before the others: more than 12 hours from the nearest
        // sighting, so it stands alone.
        observation(citizen, 'far', second(-86_400)),
      ])

      const output = await service.getFeed(request())

      expect(
        groupsOf(output.feed).map(
          ({ kind, total }) => `${kind}:${String(total)}`,
        ),
      ).toEqual(['audio:50', 'audio:60', 'observation:8'])
      expect(
        labels(output).filter((entry) => entry === 'observation:far'),
      ).toEqual(['observation:far'])
    })

    // Two recorders uploaded 1,700 and 1,400 recordings, three and four
    // seconds apart, at the same time. Adjacent-row grouping made hundreds of
    // cards of one to three recordings, and the feed was a wall of audio.
    it('shows posts and observations, not a wall of audio, when two recorders dump at once', async () => {
      const first = dumpOf('first', 1_700, 3, 20_000)
      const other = dumpOf('other', 1_400, 4, 20_050)
      const citizen = randomDid()
      const fieldworker = randomDid()
      const poster = randomDid()
      await fixture.seed([
        ...first.records,
        ...other.records,
        // A field session in the middle of the dump, and an older one.
        ...Array.from({ length: 40 }, (_, index) =>
          observation(
            citizen,
            `session${String(index)}`,
            second(15_000 - index * 30),
          ),
        ),
        ...Array.from({ length: 12 }, (_, index) =>
          observation(
            fieldworker,
            `old${String(index)}`,
            second(-40_000 - index * 60),
          ),
        ),
        // Posts before the dump, and older posts.
        ...Array.from({ length: 30 }, (_, index) =>
          post(
            poster,
            `post${String(index).padStart(2, '0')}`,
            second(-3_600 - index * 1_800),
          ),
        ),
        post(poster, 'newest', second(21_000)),
      ])
      const counted = countingService()

      const { pages, statements } = await walkCounted(counted, {}, 20)

      const firstPage = pages[0]?.feed ?? []
      const firstThree = pages.slice(0, 3).flatMap((page) => page.feed)
      expect(
        groupsOf(firstPage).map(({ kind, total }) => [kind, total]),
      ).toEqual(
        expect.arrayContaining([
          ['audio', 1_700],
          ['audio', 1_400],
          ['observation', 40],
        ]),
      )
      // Two audio cards cover the 3,100 recordings; no recording stands alone.
      expect(
        firstThree.filter(
          (item) =>
            item.$type === 'app.gainforest.feed.defs#recordItem' &&
            item.kind === 'audio',
        ),
      ).toEqual([])
      expect(
        firstThree.filter(
          (item) =>
            item.$type === 'app.gainforest.feed.defs#groupItem' &&
            item.kind === 'audio',
        ),
      ).toHaveLength(2)
      expect(
        firstThree.map(label).filter((entry) => entry.startsWith('post:')),
      ).not.toEqual([])
      // 3,157 rows are consumed, and the next row shows that the page is full:
      // 7 statements of 500 rows.
      expect(statements[0]).toBe(7)
      for (const count of statements) expect(count).toBeLessThanOrEqual(10)
      expect(
        groupsOf(pages.flatMap((page) => page.feed)).some(
          (group) => group.more === true,
        ),
      ).toBe(false)
    })
  })

  describe('the row budget', () => {
    it('ends a page at 5,000 rows, says more on the open cards, and a client merge restores the totals', async () => {
      // 4,000 and 3,000 recordings three and four seconds apart, both ending
      // at second 20,000: 7,000 rows, more than one request may consume.
      await fixture.seed([
        ...dumpOf('first', 4_000, 3, 20_000).records,
        ...dumpOf('other', 3_000, 4, 20_000).records,
        ...Array.from({ length: 30 }, (_, index) =>
          post(
            randomDid(),
            `old${String(index).padStart(2, '0')}`,
            second(-3_600 - index * 60),
          ),
        ),
      ])
      const counted = countingService()

      const { pages, statements } = await walkCounted(counted, {}, 20)

      const [firstPage, secondPage] = pages
      expect(statements[0]).toBe(REQUEST_ROWS / BATCH_ROWS)
      expect(groupsOf(firstPage?.feed ?? [])).toHaveLength(2)
      expect(
        groupsOf(firstPage?.feed ?? []).reduce(
          (sum, group) => sum + group.total,
          0,
        ),
      ).toBe(REQUEST_ROWS)
      expect(
        groupsOf(firstPage?.feed ?? []).map((group) => group.more),
      ).toEqual([true, true])
      expect(firstPage?.cursor).toBeDefined()
      // The next page continues both groups under the same keys.
      expect(
        groupsOf(secondPage?.feed ?? [])
          .map((group) => group.groupKey)
          .sort(),
      ).toEqual(
        groupsOf(firstPage?.feed ?? [])
          .map((group) => group.groupKey)
          .sort(),
      )
      expect(
        groupsOf(secondPage?.feed ?? []).reduce(
          (sum, group) => sum + group.total,
          0,
        ),
      ).toBe(2_000)
      for (const count of statements) expect(count).toBeLessThanOrEqual(10)

      // The documented client merge adds the cards of one group back up.
      expect(
        mergeGroups(pages)
          .map(({ total, more }) => [total, more])
          .sort(),
      ).toEqual([
        [3_000, false],
        [4_000, false],
      ])
    })

    it('never says more when the data or a full page ended the page', async () => {
      const owner = randomDid()
      await fixture.seed([
        ...Array.from({ length: 30 }, (_, index) =>
          audio(owner, `a${String(index).padStart(2, '0')}`, second(index)),
        ),
        post(owner, 'older', minute(-1_000)),
      ])

      const pages = await walk({}, 1)

      expect(
        pages.flatMap((page) => groupsOf(page.feed)).map((g) => g.more),
      ).toEqual([undefined])
    })

    it('ends a small page at a small budget in the same way', async () => {
      const owner = randomDid()
      await fixture.seed(
        Array.from({ length: 20 }, (_, index) =>
          audio(owner, `a${String(index).padStart(2, '0')}`, second(index)),
        ),
      )
      const small = serviceFor({ batchRows: 4, requestRows: 8 })

      const pages = await walk({}, 5, small)

      expect(
        pages.map((page) =>
          groupsOf(page.feed).map(({ total, more }) => [total, more]),
        ),
      ).toEqual([[[8, true]], [[8, true]], [[4, undefined]]])
    })
  })

  describe('statements per request', () => {
    it('runs one statement when the first batch fills the page', async () => {
      const did = randomDid()
      await fixture.seed(
        Array.from({ length: 100 }, (_, index) =>
          post(did, `p${String(index).padStart(3, '0')}`, minute(index)),
        ),
      )
      const counted = countingService()

      const page = await counted.service.getFeed(request({ limit: 20 }))

      expect(page.feed).toHaveLength(20)
      expect(counted.statements()).toBe(1)
    })

    it('runs one more statement for a page that ends exactly at the end of a batch', async () => {
      const did = randomDid()
      await fixture.seed(
        Array.from({ length: 12 }, (_, index) =>
          post(did, `p${String(index).padStart(3, '0')}`, minute(index)),
        ),
      )
      const counted = countingService({ batchRows: 4 })

      // Rows 0 to 7 fill the page; row 8 is in the third batch.
      await counted.service.getFeed(request({ limit: 8 }))
      expect(counted.statements()).toBe(3)

      counted.reset()
      // Rows 0 to 3 fill the page; the row that shows it is full is in the second batch.
      await counted.service.getFeed(request({ limit: 4 }))
      expect(counted.statements()).toBe(2)
    })

    it('runs a statement per batch a long group needs and never more than ten', async () => {
      const owner = randomDid()
      await fixture.seed([
        ...Array.from({ length: 6_000 }, (_, index) =>
          audio(owner, `a${String(index).padStart(5, '0')}`, second(index)),
        ),
        post(owner, 'older', minute(-1_000)),
      ])
      const counted = countingService()

      const { statements } = await walkCounted(counted, {}, 20)

      expect(statements).toEqual([10, 3])
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

    it('ends a page before the row that would start another card, never in the middle of a group', async () => {
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
          `observation(30):${Array.from({ length: 20 }, (_, index) => `o${String(29 - index).padStart(2, '0')}`).join(',')}`,
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

    // A cursor that the service issued before this version could not say, or
    // said by naming a group, how a page continues a card. Clients start again.
    it.each([1, 2])(
      'rejects a version %i cursor and says to request the first page again',
      async (version) => {
        const cursor = Buffer.from(
          JSON.stringify({
            version,
            feedId: ACTIVITY_FEED_ID,
            value: { value: minute(1), uri: 'at://did:plc:x/y/z' },
          }),
        ).toString('base64url')

        for (const procedure of ['getFeed', 'getFeedSkeleton'] as const) {
          const { status, body } = await call(procedure, request({ cursor }))

          expect(status, procedure).toBe(400)
          expect(body, procedure).toMatchObject({
            error: 'InvalidCursor',
            message: expect.stringContaining('version must be 3') as unknown,
          })
        }
      },
    )

    it('splits a group at a page edge into cards that share one groupKey, and the documented merge joins them', async () => {
      const did = randomDid()
      await fixture.seed([
        ...Array.from({ length: 12 }, (_, index) =>
          observation(did, `o${String(index).padStart(2, '0')}`, minute(index)),
        ),
        // Between o06 and o07, so a page of one card ends at it.
        post(randomDid(), 'edge', minute(6.5)),
      ])

      const pages = await walk({}, 1)

      expect(pages.map(labels)).toEqual([
        [
          `observation(5):${['11', '10', '09', '08', '07'].map((n) => `o${n}`).join(',')}`,
        ],
        ['post:edge'],
        [
          `observation(7):${['06', '05', '04', '03', '02', '01', '00'].map((n) => `o${n}`).join(',')}`,
        ],
      ])
      const [head, , tail] = pages.map((page) => groupsOf(page.feed)[0])
      expect(head?.groupKey).toBeDefined()
      expect(tail?.groupKey).toBe(head?.groupKey)
      expect(mergeGroups(pages)).toMatchObject([{ total: 12, more: false }])
    })

    it('does not merge a later card of the same group after a gap of more than 12 hours', async () => {
      const did = randomDid()
      await fixture.seed([
        ...['a', 'b', 'c'].map((rkey, index) =>
          observation(did, `new-${rkey}`, minute(2_000 + index)),
        ),
        post(randomDid(), 'edge', minute(1_000)),
        ...['a', 'b', 'c'].map((rkey, index) =>
          observation(did, `old-${rkey}`, minute(index)),
        ),
      ])

      const pages = await walk({}, 1)

      expect(mergeGroups(pages)).toMatchObject([{ total: 3 }, { total: 3 }])
      const keys = pages
        .flatMap((page) => groupsOf(page.feed))
        .map((g) => g.groupKey)
      expect(keys).toHaveLength(2)
      expect(keys[1]).toBe(keys[0])
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
    // DID of 1,990 characters is valid (a DID may have 2,048). An earlier
    // cursor carried it twice, so a page whose last item was a cut group had
    // a cursor over the 4,096 characters the response allows and answered 500
    // for every client. The cursor now holds the last consumed row and nothing
    // else, but the pages of such a folder still have to be served.
    it('answers every page of a group in a folder with a 1,990-character DID, on both procedures and at every page size', async () => {
      const uploader = randomDid()
      const longDid = `did:web:${'a'.repeat(1_990)}`
      const folder = `at://${longDid}/app.gainforest.ac.deployment/x`
      await fixture.seed([
        ...Array.from({ length: 40 }, (_, index) =>
          audio(uploader, `r${pad(index)}`, second(index), folder),
        ),
        ...Array.from({ length: 3 }, (_, index) =>
          post(randomDid(), `older${String(index)}`, minute(-1_000 - index)),
        ),
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
      expect(pages[0]?.feed[0]).toMatchObject({ did: longDid, total: 40 })
    })

    it('names only the last consumed row', async () => {
      const did = randomDid()
      await fixture.seed([
        ...Array.from({ length: 30 }, (_, index) =>
          audio(
            did,
            `r${pad(index)}`,
            second(index),
            `at://${did}/app.gainforest.ac.deployment/f`,
          ),
        ),
        post(did, 'older', minute(-1_000)),
      ])

      const page = await service.getFeed(request({ limit: 1 }))

      expect(
        decodeCursor(ACTIVITY_FEED_ID, page.cursor, timestampUriCursor),
      ).toEqual({
        value: expect.stringMatching(
          /^2026-03-01T00:00:00\.000000Z$/,
        ) as unknown,
        uri: `at://${did}/${AUDIO}/r${pad(0)}`,
      })
      const payload: unknown = JSON.parse(
        Buffer.from(page.cursor ?? '', 'base64url').toString('utf8'),
      )
      expect(payload).toEqual({
        version: 3,
        feedId: ACTIVITY_FEED_ID,
        value: {
          value: '2026-03-01T00:00:00.000000Z',
          uri: `at://${did}/${AUDIO}/r${pad(0)}`,
        },
      })
    })

    it('rejects a cursor that names a group, as a version 3 cursor must not', async () => {
      const did = randomDid()
      const cursor = Buffer.from(
        JSON.stringify({
          version: 3,
          feedId: ACTIVITY_FEED_ID,
          value: {
            value: minute(1),
            uri: `at://${did}/${AUDIO}/x`,
            group: { key: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'audio' },
          },
        }),
      ).toString('base64url')

      for (const procedure of ['getFeed', 'getFeedSkeleton'] as const) {
        const { status, body } = await call(procedure, request({ cursor }))

        expect(status, procedure).toBe(400)
        expect(body, procedure).toMatchObject({ error: 'InvalidCursor' })
      }
    })

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

    it('lists every row of a group, not only its samples, and shares the cursor', async () => {
      const did = randomDid()
      await fixture.seed([
        ...Array.from({ length: 45 }, (_, index) =>
          observation(did, `o${String(index).padStart(3, '0')}`, second(index)),
        ),
        post(randomDid(), 'older', minute(-1_000)),
      ])

      const full = await service.getFeed(request({ limit: 1 }))
      const skeleton = await service.getFeedSkeleton(request({ limit: 1 }))

      expect(full.feed[0]).toMatchObject({ total: 45 })
      expect(groupsOf(full.feed)[0]?.subjects).toHaveLength(20)
      expect(skeleton.cursor).toBeDefined()
      expect(skeleton.cursor).toBe(full.cursor)
      expect(skeleton.feed.map(({ subject }) => rkeyOf(subject))).toEqual(
        Array.from(
          { length: 45 },
          (_, index) => `o${String(44 - index).padStart(3, '0')}`,
        ),
      )
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
     * timestamp, across kinds and inside one account's group.
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
          clock += 12 * 3_600_000 // exactly 12 hours: still one group
        } else if (roll < 0.97) {
          clock += 12 * 3_600_000 + 1 // 12 hours and a millisecond: split
        } else {
          clock += 3 * 3_600_000
        }
        return new Date(clock).toISOString()
      }

      /**
       * A session: a few rows of one group close together, a gap of exactly 12
       * hours, of 12 hours and a millisecond, or of 14 hours, and a few more
       * rows of the same group. It is the group the gap rule joins or splits.
       */
      const session = (): void => {
        const did = pick(dids)
        const recordings = next() < 0.5
        const folder = pick(folders)
        const gap = pick([12 * 3_600_000, 12 * 3_600_000 + 1, 14 * 3_600_000])
        const rows = (count: number): void => {
          for (let index = 0; index < count; index += 1) {
            clock += ties ? 0 : 1 + Math.floor(next() * 60_000)
            const createdAt = new Date(clock).toISOString()
            records.push(
              recordings
                ? audio(did, key(), createdAt, folder)
                : observation(did, key(), createdAt),
            )
          }
        }
        rows(3 + Math.floor(next() * 3))
        clock += gap
        rows(3 + Math.floor(next() * 3))
      }

      // Rows often repeat the previous row's account and kind, so the data has
      // streaks long enough to make groups.
      let lastDid = pick(dids)
      let lastRoll = next()
      let lastFolder = pick(folders)
      for (let step = 0; step < 260; step += 1) {
        if (next() < 0.04) {
          session()
          continue
        }
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

    /**
     * Pages the feed to the end and compares every page with the model: its
     * items, whether it has a cursor, the statements the request sent, and the
     * skeleton of the same page.
     */
    const expectModelFeed = async (
      records: readonly SeedRecord[],
      sizes: ActivityFeedOptions,
    ): Promise<void> => {
      const uriRank = await fixture.uriOrder(records.map(uriOf))
      const counted = countingService(sizes)
      const filters = [
        'all',
        'project',
        'observation',
        'organization',
        'post',
        'audio',
      ]
      for (const filter of filters) {
        for (const limit of [1, 3, 7, 20, 50]) {
          const expected = modelPages(records, {
            filter,
            limit,
            uriRank,
            ...sizes,
          })
          let cursor: string | undefined
          for (const [index, page] of expected.entries()) {
            const where = `filter ${filter}, limit ${String(limit)}, page ${String(index + 1)}`
            const input = request({
              filter,
              limit,
              ...(cursor === undefined ? {} : { cursor }),
            })

            counted.reset()
            const actual = await counted.service.getFeed(input)

            expect(modelOf(actual.feed), where).toEqual(page.items)
            expect(actual.cursor !== undefined, `${where}: cursor`).toBe(
              page.hasNext,
            )
            expect(counted.statements(), `${where}: statements`).toBe(
              page.statements,
            )
            const skeleton = await counted.service.getFeedSkeleton(input)
            expect(
              skeleton.feed.map(({ subject }) => subject),
              `${where}: skeleton`,
            ).toEqual(page.uris)
            expect(skeleton.cursor, `${where}: skeleton cursor`).toBe(
              actual.cursor,
            )
            cursor = actual.cursor
          }
          expect(cursor, `filter ${filter}, limit ${String(limit)}: end`).toBe(
            undefined,
          )
        }
      }
    }

    it('has data rich enough for the comparisons to cover groups, small groups shown as records, groups split by a gap, budget stops, and pages over the limit', () => {
      const records = randomDataset(1, true)
      const small = modelPages(records, {
        filter: 'all',
        limit: 3,
        batchRows: 3,
        requestRows: 13,
      })
      const wide = modelPages(records, {
        filter: 'all',
        limit: 20,
        batchRows: 7,
        requestRows: 40,
      })
      const items = small.flatMap((page) => page.items)
      const groups = items.filter((item) => item.type === 'group')

      expect(groups.map((group) => group.kind)).toContain('observation')
      expect(groups.map((group) => group.kind)).toContain('audio')
      expect(
        items.some((item) => item.type === 'record' && item.kind === 'audio'),
      ).toBe(true)
      expect(
        items.some(
          (item) => item.type === 'record' && item.kind === 'observation',
        ),
      ).toBe(true)
      expect(groups.some((group) => group.more)).toBe(true)
      expect(small.some((page) => page.items.length > 3)).toBe(true)
      // Two cards of one group on one page: a gap of more than 12 hours.
      expect(
        wide.some((page) => {
          const groups = page.items.flatMap((item) =>
            item.type === 'group' ? [item.groupIndex] : [],
          )
          return new Set(groups).size < groups.length
        }),
      ).toBe(true)
    })

    it('lists every selectable row exactly once across a full walk, at several limits and budgets', async () => {
      const records = randomDataset(5, false)
      await fixture.seed(records)
      const uriRank = await fixture.uriOrder(records.map(uriOf))
      const everything = modelRowUris(records, {
        filter: 'all',
        uriRank,
      }).sort()
      expect(everything.length).toBeGreaterThan(100)

      for (const sizes of [
        {},
        { batchRows: 7, requestRows: 25 },
        { batchRows: 1, requestRows: 4 },
      ] satisfies ActivityFeedOptions[]) {
        const reader = serviceFor(sizes)
        for (const limit of [1, 3, 20, 50]) {
          const context = `${JSON.stringify(sizes)}, limit ${String(limit)}`
          const uris: string[] = []
          let cursor: string | undefined
          do {
            const page = await reader.getFeedSkeleton(
              request({
                limit,
                ...(cursor === undefined ? {} : { cursor }),
              }),
            )
            uris.push(...page.feed.map(({ subject }) => subject))
            cursor = page.cursor
          } while (cursor !== undefined)
          expect([...uris].sort(), context).toEqual(everything)

          // The cards add up to the same rows: a group counts its total.
          const items = await allItems({}, limit, reader)
          expect(
            items.reduce(
              (sum, item) =>
                sum +
                (item.$type === 'app.gainforest.feed.defs#groupItem'
                  ? item.total
                  : 1),
              0,
            ),
            context,
          ).toBe(everything.length)
        }
      }
    }, 180_000)

    const configurations = [
      {
        name: 'production sizes, unique timestamps',
        ties: false,
        sizes: {},
        seeds: [1, 2, 3, 4],
      },
      {
        name: 'production sizes, tied timestamps',
        ties: true,
        sizes: {},
        seeds: [1, 2],
      },
      {
        name: 'batches of 7 rows and a budget of 40, unique timestamps',
        ties: false,
        sizes: { batchRows: 7, requestRows: 40 },
        seeds: [1, 2, 3],
      },
      {
        name: 'batches of 3 rows and a budget of 13, tied timestamps',
        ties: true,
        sizes: { batchRows: 3, requestRows: 13 },
        seeds: [1, 2, 3],
      },
      {
        name: 'one-row batches and a budget of 9, unique timestamps',
        ties: false,
        sizes: { batchRows: 1, requestRows: 9 },
        seeds: [1, 2],
      },
      {
        name: 'a budget that is not a multiple of the batch, tied timestamps',
        ties: true,
        sizes: { batchRows: 4, requestRows: 10 },
        seeds: [1, 2],
      },
      {
        name: 'a budget of one batch, unique timestamps',
        ties: false,
        sizes: { batchRows: 5, requestRows: 5 },
        seeds: [1],
      },
    ] as const satisfies readonly {
      name: string
      ties: boolean
      sizes: ActivityFeedOptions
      seeds: readonly number[]
    }[]

    describe.each(configurations)('$name', (configuration) => {
      it.each(configuration.seeds)(
        'pages random dataset %i exactly like the model for every filter and page size',
        async (seed) => {
          const records = randomDataset(seed, configuration.ties)
          await fixture.seed(records)

          await expectModelFeed(records, configuration.sizes)
        },
        180_000,
      )
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

  // The feed statement runs in a few milliseconds and its estimated cost grows
  // with the table: above `jit_above_cost` PostgreSQL would compile it and add
  // 100 to 150 ms to every batch. The pool has to get the setting to the server.
  it('opens every session with JIT off', async () => {
    const { rows } = await database.query<{ jit: string; read_only: string }>(
      `SELECT current_setting('jit') AS jit,
              current_setting('default_transaction_read_only') AS read_only`,
    )

    expect(rows).toEqual([{ jit: 'off', read_only: 'on' }])
  })
})
