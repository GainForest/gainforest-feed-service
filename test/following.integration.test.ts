import { LexServerAuthError } from '@atproto/lex-server'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import type {
  OptionalServiceAuth,
  ServiceAuthCredentials,
} from '../src/auth/service-auth.js'
import {
  MAX_FOLLOWED_ACCOUNTS,
  createFollowingFeed,
  type FollowingFeedOptions,
} from '../src/feed/following.js'
import { createActivityFeed } from '../src/feed/query.js'
import { FeedRegistry } from '../src/feed/registry.js'
import { FeedService } from '../src/feed/service.js'
import {
  ACTIVITY_FEED_ID,
  ACTIVITY_FEED_PARAMS_TYPE,
  FOLLOWING_FEED_ID,
  FOLLOWING_FEED_PARAMS_TYPE,
  type ActivityFeedItem,
  type FeedRequest,
  type GetFeedOutput,
  type GroupItem,
} from '../src/feed/types.js'
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
const minute = (minutes: number): string =>
  new Date(BASE + minutes * 60_000).toISOString()

const OBSERVATION = 'app.gainforest.dwc.occurrence'
const POST = 'app.gainforest.feed.post'
const REPOST = 'app.gainforest.feed.repost'
const PROJECT = 'org.hypercerts.collection'
const ORGANIZATION = 'app.certified.actor.organization'
const AUDIO = 'app.gainforest.ac.audio'
const DEPLOYMENT = 'app.gainforest.ac.deployment'
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

/** A recorder folder: the deployment record an account stores. */
const folderRecord = (
  owner: string,
  rkey: string,
  createdAt = minute(0),
): SeedRecord => ({
  did: owner,
  collection: DEPLOYMENT,
  rkey,
  createdAt,
})

const folderUri = (owner: string, rkey: string): string =>
  uriOf(folderRecord(owner, rkey))

const follow = (
  viewer: string,
  subject: string,
  createdAt: string | null = minute(0),
): SeedRecord => ({
  did: viewer,
  collection: FOLLOW,
  rkey: `follow-${subject.slice(-8)}`,
  createdAt,
  json: { subject },
})

const rkeyOf = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A compact, comparable form of service items; see the activity feed's tests. */
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

const labels = (output: GetFeedOutput): string[] => output.feed.map(label)

const groupsOf = (items: readonly ActivityFeedItem[]): GroupItem[] =>
  items.flatMap((item) =>
    item.$type === 'app.gainforest.feed.defs#groupItem' ? [item] : [],
  )

const isServiceDid = (value: string): value is ServiceAuthCredentials['did'] =>
  value.startsWith('did:plc:') || value.startsWith('did:web:')

const defined = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Expected a value.')
  return value
}

const credentialsOf = (value: string): ServiceAuthCredentials => {
  if (!isServiceDid(value)) throw new Error(`${value} is not a DID.`)
  return serviceCredentials(value)
}

const serviceCredentials = (
  did: ServiceAuthCredentials['did'],
): ServiceAuthCredentials => ({
  did,
  didDocument: { id: did },
  jwt: {
    header: { alg: 'ES256' },
    payload: {
      iss: did,
      aud: 'did:web:feed.example',
      exp: 1,
      lxm: 'app.gainforest.feed.getFeed',
    },
    message: new Uint8Array(),
    signature: new Uint8Array(),
  },
})

const authFor =
  (credentials: ServiceAuthCredentials | undefined): OptionalServiceAuth =>
  ({ request }) => {
    if (credentials !== undefined && request.headers.has('authorization')) {
      return Promise.resolve(credentials)
    }
    if (request.headers.has('authorization')) {
      return Promise.reject(
        new LexServerAuthError('AuthenticationRequired', 'Invalid token', {
          Bearer: { error: 'InvalidToken' },
        }),
      )
    }
    return Promise.resolve(undefined)
  }

describe('GainForest following feed against Hyperindex Postgres', () => {
  let fixture: RecordFixture
  let metrics: Metrics

  /** The statements a service sent, with the values they were sent with. */
  interface Sent {
    readonly text: string
    readonly values: readonly unknown[]
  }

  /**
   * A feed service over the fixture with both feeds registered, as in
   * production, optionally with small batch, budget, and follow-cap sizes. It
   * records the statements it sends to the database.
   */
  const countingService = (options: FollowingFeedOptions = {}) => {
    let sent: Sent[] = []
    const database = {
      query: (text: string, values: readonly unknown[] = []) => {
        sent.push({ text, values })
        return fixture.database.query(text, values)
      },
    }
    const service = new FeedService(
      new FeedRegistry([
        createActivityFeed({ database, metrics }, options),
        createFollowingFeed({ database, metrics }, options),
      ]),
    )
    return {
      service,
      statements: () => sent.length,
      lastStatement: () => sent.at(-1),
      reset: () => {
        sent = []
      },
    }
  }

  let service: FeedService
  const serviceFor = (options: FollowingFeedOptions = {}): FeedService =>
    countingService(options).service

  beforeEach(async () => {
    fixture = await RecordFixture.create(TEST_DATABASE_URL)
    metrics = new Metrics()
    service = serviceFor()
  })

  afterEach(async () => {
    await fixture.close()
  })

  const request = (
    viewerDid: string | undefined,
    options: {
      readonly filter?: string
      readonly limit?: number
      readonly cursor?: string
    } = {},
  ): FeedRequest => ({
    feedId: FOLLOWING_FEED_ID,
    params: {
      $type: FOLLOWING_FEED_PARAMS_TYPE,
      ...(viewerDid === undefined ? {} : { viewerDid }),
      ...(options.filter === undefined ? {} : { filter: options.filter }),
    },
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  })

  const activityRequest = (
    options: { readonly limit?: number; readonly cursor?: string } = {},
  ): FeedRequest => ({
    feedId: ACTIVITY_FEED_ID,
    params: { $type: ACTIVITY_FEED_PARAMS_TYPE },
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  })

  const feedOf = (viewer: string): Promise<GetFeedOutput> =>
    service.getFeed(request(viewer))

  /** Pages through the whole following feed, returning every page. */
  const walk = async (
    viewer: string,
    filter: string | undefined,
    limit: number,
    reader: FeedService = service,
  ): Promise<GetFeedOutput[]> => {
    const pages: GetFeedOutput[] = []
    let cursor: string | undefined
    do {
      const page = await reader.getFeed(
        request(viewer, {
          limit,
          ...(filter === undefined ? {} : { filter }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      )
      pages.push(page)
      cursor = page.cursor
      expect(pages.length).toBeLessThan(500)
    } while (cursor !== undefined)
    return pages
  }

  /**
   * Runs a statement the service sent under EXPLAIN ANALYZE and returns the
   * scans of `record` the plan contains: the index each one used, the rows it
   * read (returned or removed by its filter), and how many times it ran. The
   * viewer's follow records (alias `follow`) are left out: they are not a feed
   * read.
   */
  const scansOf = async (
    statement: Sent | undefined,
  ): Promise<{ index: string; rowsRead: number; loops: number }[]> => {
    if (statement === undefined) throw new Error('No statement was sent.')
    const { rows } = await fixture.database.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
      statement.values,
    )
    const scans: { index: string; rowsRead: number; loops: number }[] = []
    const visit = (node: unknown): void => {
      if (!isObject(node)) return
      const children = node.Plans
      const loops = node['Actual Loops']
      if (
        node['Relation Name'] === 'record' &&
        node.Alias !== 'follow' &&
        typeof loops === 'number'
      ) {
        const returned = Number(node['Actual Rows'] ?? 0)
        const removed = Number(node['Rows Removed by Filter'] ?? 0)
        scans.push({
          index: String(node['Index Name'] ?? node['Node Type']),
          rowsRead: (returned + removed) * loops,
          loops,
        })
      }
      if (Array.isArray(children)) children.forEach(visit)
    }
    for (const row of rows as readonly unknown[]) {
      const plans = isObject(row) ? row['QUERY PLAN'] : undefined
      if (!Array.isArray(plans)) continue
      for (const entry of plans) {
        if (isObject(entry)) visit(entry.Plan)
      }
    }
    return scans
  }

  /**
   * How many scans of `record` that ran (at least once) a statement's CTE
   * `name` contains, under EXPLAIN ANALYZE. A CTE behind a one-time filter
   * that is false has its scans in the plan, and none of them runs.
   */
  const scansRunByCte = async (
    statement: Sent | undefined,
    name: string,
  ): Promise<number> => {
    if (statement === undefined) throw new Error('No statement was sent.')
    const { rows } = await fixture.database.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
      statement.values,
    )
    const state = { found: false, ran: 0 }
    const visit = (node: unknown, inside: boolean): void => {
      if (!isObject(node)) return
      const isCte = node['Subplan Name'] === `CTE ${name}`
      const here = inside || isCte
      if (isCte) state.found = true
      if (
        here &&
        node['Relation Name'] === 'record' &&
        Number(node['Actual Loops']) > 0
      ) {
        state.ran += 1
      }
      if (Array.isArray(node.Plans)) {
        for (const child of node.Plans) visit(child, here)
      }
    }
    for (const row of rows as readonly unknown[]) {
      const plans = isObject(row) ? row['QUERY PLAN'] : undefined
      if (!Array.isArray(plans)) continue
      for (const entry of plans) {
        if (isObject(entry)) visit(entry.Plan, false)
      }
    }
    if (!state.found) throw new Error(`The plan has no CTE ${name}.`)
    return state.ran
  }

  /**
   * The primary-key lookups the final step of a statement ran for the
   * bioacoustic flag, under EXPLAIN ANALYZE: how many times the scan ran and
   * how many buffers it touched. The scan sits outside every CTE; the repost
   * subject lookups, which also use the primary key, sit inside `authored`.
   */
  const sidecarLookupOf = async (
    statement: Sent | undefined,
  ): Promise<{ loops: number; buffers: number }[]> => {
    if (statement === undefined) throw new Error('No statement was sent.')
    const { rows } = await fixture.database.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
      statement.values,
    )
    const lookups: { loops: number; buffers: number }[] = []
    const visit = (node: unknown, insideCte: boolean): void => {
      if (!isObject(node)) return
      const subplan = node['Subplan Name']
      const inside =
        insideCte || (typeof subplan === 'string' && subplan.startsWith('CTE '))
      if (
        !inside &&
        node['Relation Name'] === 'record' &&
        node['Index Name'] === 'record_pkey'
      ) {
        lookups.push({
          loops: Number(node['Actual Loops']),
          buffers:
            Number(node['Shared Hit Blocks'] ?? 0) +
            Number(node['Shared Read Blocks'] ?? 0),
        })
      }
      if (Array.isArray(node.Plans)) {
        for (const child of node.Plans) visit(child, inside)
      }
    }
    for (const row of rows as readonly unknown[]) {
      const plans = isObject(row) ? row['QUERY PLAN'] : undefined
      if (!Array.isArray(plans)) continue
      for (const entry of plans) {
        if (isObject(entry)) visit(entry.Plan, false)
      }
    }
    return lookups
  }

  describe('selection', () => {
    it('limits every kind to followed authors, reposts to the reposter, and recordings to the folder owner', async () => {
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
        // Every kind is scoped, so none of a stranger's records may appear.
        post(stranger, 'p-stranger', minute(70)),
        project(stranger, 'c-stranger', minute(71)),
        organization(stranger, minute(72)),
        observation(stranger, 'o-stranger', minute(73)),
        audio(stranger, 'a-stranger', minute(74)),
        original,
      ])

      const output = await feedOf(viewer)

      expect(labels(output)).toEqual([
        'repost:r-by-followed',
        'audio:a1',
        'organization:self',
        'observation:o1',
        'post:p1',
        'project:c1',
      ])
    })

    it("does not show the viewer's own records unless the viewer follows themselves", async () => {
      const viewer = randomDid()
      const followed = randomDid()
      await fixture.seed([
        follow(viewer, followed),
        post(viewer, 'mine', minute(1)),
        post(followed, 'theirs', minute(2)),
      ])
      expect(labels(await feedOf(viewer))).toEqual(['post:theirs'])

      const selfFollower = randomDid()
      await fixture.seed([
        follow(selfFollower, selfFollower),
        post(selfFollower, 'mine', minute(3)),
      ])
      expect(labels(await feedOf(selfFollower))).toEqual(['post:mine'])
    })

    it("applies the activity feed's selection rules to a followed account's records", async () => {
      const viewer = randomDid()
      const followed = randomDid()
      const stranger = randomDid()
      const ownSubject = post(followed, 'own-subject', minute(0))
      await fixture.seed([
        ownSubject,
        follow(viewer, followed),
        post(followed, 'ok', minute(1)),
        { ...post(followed, 'invalid', minute(2)), validation: 'invalid' },
        post(followed, 'reply', minute(3), {
          reply: { root: { uri: 'at://x/y/z', cid } },
        }),
        post(followed, 'event', minute(4), { tags: ['community-event'] }),
        project(followed, 'list', minute(5), 'list'),
        project(followed, 'upper', minute(6), 'Project'),
        observation(followed, 'no-date', null),
        observation(followed, 'future', '2099-06-01T00:00:00.000Z'),
        observation(followed, 'epoch', '1969-12-31T23:59:59.000Z'),
        observation(followed, 'year-10000', '10000-01-01T04:59:59Z'),
        {
          did: followed,
          collection: RECEIPT,
          rkey: 'donation',
          createdAt: minute(7),
        },
        // Reposts need a subject that would itself be a feed record by
        // another account.
        repost(followed, 'r-ok', minute(8), post(stranger, 's1', minute(0))),
        repost(followed, 'r-own', minute(9), ownSubject),
        repost(
          followed,
          'r-reply',
          minute(10),
          post(stranger, 's2', minute(0), {
            reply: { root: { uri: 'at://x/y/z', cid } },
          }),
        ),
        repost(
          followed,
          'r-gone',
          minute(11),
          post(stranger, 'never-stored', minute(0)),
        ),
        post(stranger, 's1', minute(0)),
      ])

      const output = await feedOf(viewer)

      expect(labels(output)).toEqual([
        'repost:r-ok',
        'project:upper',
        'post:ok',
        'post:own-subject',
      ])
    })

    it('filters by kind like the activity feed, reposts only in the all filter', async () => {
      const viewer = randomDid()
      const followed = randomDid()
      const subject = post(randomDid(), 's', minute(0))
      await fixture.seed([
        subject,
        follow(viewer, followed),
        post(followed, 'p1', minute(1)),
        observation(followed, 'o1', minute(2)),
        repost(followed, 'r1', minute(3), subject),
        audio(followed, 'a1', minute(4)),
      ])

      const kinds = async (filter: string): Promise<string[]> =>
        labels(await service.getFeed(request(viewer, { filter })))

      expect(await kinds('post')).toEqual(['post:p1'])
      expect(await kinds('observation')).toEqual(['observation:o1'])
      expect(await kinds('audio')).toEqual(['audio:a1'])
      expect(await kinds('project')).toEqual([])
      expect(await kinds('all')).toEqual([
        'audio:a1',
        'repost:r1',
        'observation:o1',
        'post:p1',
      ])
    })

    it('lists a record once when the viewer follows its account twice', async () => {
      const viewer = randomDid()
      const followed = randomDid()
      await fixture.seed([
        follow(viewer, followed),
        { ...follow(viewer, followed), rkey: 'follow-again' },
        post(followed, 'p1', minute(1)),
      ])

      expect(labels(await feedOf(viewer))).toEqual(['post:p1'])
    })

    it('folds a followed account into the same groups, with the same keys, as the activity feed', async () => {
      const viewer = randomDid()
      const followed = randomDid()
      const other = randomDid()
      await fixture.seed([
        follow(viewer, followed),
        observation(followed, 'o1', minute(1)),
        observation(followed, 'o2', minute(2)),
        observation(followed, 'o3', minute(3)),
        observation(other, 'x1', minute(4)),
      ])

      const following = groupsOf((await feedOf(viewer)).feed)
      const activity = groupsOf(
        (await service.getFeed(activityRequest())).feed,
      ).filter((group) => group.did === followed)

      expect(following).toHaveLength(1)
      expect(following[0]).toMatchObject({ total: 3, did: followed })
      expect(following).toEqual(activity)
    })
  })

  describe('follows', () => {
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
        { did: viewer, collection: FOLLOW, rkey: 'none', createdAt: minute(0) },
        post(author, 'p1', minute(1)),
      ])

      await expect(feedOf(viewer)).resolves.toEqual({ feed: [] })
    })

    it("does not follow other viewers' follows", async () => {
      const viewer = randomDid()
      const author = randomDid()
      await fixture.seed([
        follow(randomDid(), author),
        post(author, 'p1', minute(1)),
      ])

      await expect(feedOf(viewer)).resolves.toEqual({ feed: [] })
    })

    it('reads a follow whose createdAt Hyperindex could not parse, after the ones it could', async () => {
      const viewer = randomDid()
      const dated = randomDid()
      const undated = randomDid()
      await fixture.seed([
        follow(viewer, dated, minute(5)),
        follow(viewer, undated, null),
        post(dated, 'p-dated', minute(1)),
        post(undated, 'p-undated', minute(2)),
      ])

      expect(labels(await feedOf(viewer))).toEqual([
        'post:p-undated',
        'post:p-dated',
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
          audio(stranger, 'a1', minute(5), folderUri(stranger, 'f')),
          folderRecord(stranger, 'f'),
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

        await expect(counted.service.getFeed(request(viewer))).resolves.toEqual(
          { feed: [] },
        )
        expect(counted.statements()).toBe(1)
      })

      // The statement starts from the followed accounts, so with none it runs
      // no read of any collection. The page is empty either way, so only the
      // plan shows it.
      it('reads no feed collection', async () => {
        const viewer = randomDid()
        await seedStrangers()
        const counted = countingService()
        await counted.service.getFeed(request(viewer))

        const scans = await scansOf(counted.lastStatement())

        // Every read of the statement is in the plan, and none of them ran.
        expect(scans.length).toBeGreaterThanOrEqual(8)
        expect(scans.filter(({ loops }) => loops > 0)).toEqual([])
      })
    })
  })

  describe('the follow cap', () => {
    it('reads the most recently followed accounts when the viewer follows more than the cap', async () => {
      const viewer = randomDid()
      const [oldest, middle, newest] = [randomDid(), randomDid(), randomDid()]
      await fixture.seed([
        follow(viewer, oldest, minute(1)),
        follow(viewer, newest, minute(3)),
        follow(viewer, middle, minute(2)),
        post(oldest, 'p-oldest', minute(10)),
        post(middle, 'p-middle', minute(11)),
        post(newest, 'p-newest', minute(12)),
      ])

      const capped = serviceFor({ maxFollowedAccounts: 2 })
      const uncapped = serviceFor({ maxFollowedAccounts: 3 })

      expect(labels(await capped.getFeed(request(viewer)))).toEqual([
        'post:p-newest',
        'post:p-middle',
      ])
      expect(labels(await uncapped.getFeed(request(viewer)))).toEqual([
        'post:p-newest',
        'post:p-middle',
        'post:p-oldest',
      ])
    })

    // The cap is on accounts: the follow records of one account must not use
    // up slots that other accounts could have.
    it('counts followed accounts, not follow records, against the cap', async () => {
      const viewer = randomDid()
      const [a, b] = [randomDid(), randomDid()]
      await fixture.seed([
        follow(viewer, a, minute(1)),
        follow(viewer, b, minute(2)),
        { ...follow(viewer, b, minute(3)), rkey: 'follow-again' },
        post(a, 'p-a', minute(10)),
        post(b, 'p-b', minute(11)),
      ])

      const twoAccounts = serviceFor({ maxFollowedAccounts: 2 })
      const oneAccount = serviceFor({ maxFollowedAccounts: 1 })

      // Two follow records of B and one of A are two accounts, so both stay
      // under a cap of 2; a cap of 1 keeps the newest-followed one.
      expect(labels(await twoAccounts.getFeed(request(viewer)))).toEqual([
        'post:p-b',
        'post:p-a',
      ])
      expect(labels(await oneAccount.getFeed(request(viewer)))).toEqual([
        'post:p-b',
      ])
    })

    it('places an account by its newest follow record', async () => {
      const viewer = randomDid()
      const [a, b] = [randomDid(), randomDid()]
      await fixture.seed([
        follow(viewer, a, minute(1)),
        follow(viewer, b, minute(3)),
        // A is followed again after B: A is now the most recently followed.
        { ...follow(viewer, a, minute(5)), rkey: 'follow-again' },
        post(a, 'p-a', minute(10)),
        post(b, 'p-b', minute(11)),
      ])

      const oneAccount = serviceFor({ maxFollowedAccounts: 1 })

      expect(labels(await oneAccount.getFeed(request(viewer)))).toEqual([
        'post:p-a',
      ])
    })

    it('breaks ties between follows made at the same time by URI, newest URI first', async () => {
      const viewer = randomDid()
      const accounts = [randomDid(), randomDid(), randomDid()]
      const follows = accounts.map((account) => follow(viewer, account))
      await fixture.seed([
        ...follows,
        ...accounts.map((account, index) =>
          post(account, `p${String(index)}`, minute(index + 1)),
        ),
      ])
      const rank = await fixture.uriOrder(follows.map(uriOf))
      // Rank 0 sorts first when ordering by URI descending.
      const firstTwo = follows
        .map((record, index) => ({ record, index }))
        .sort(
          (a, b) =>
            (rank.get(uriOf(a.record)) ?? 0) - (rank.get(uriOf(b.record)) ?? 0),
        )
        .slice(0, 2)
        .map(({ index }) => `post:p${String(index)}`)

      const capped = serviceFor({ maxFollowedAccounts: 2 })

      expect(labels(await capped.getFeed(request(viewer))).sort()).toEqual(
        firstTwo.sort(),
      )
    })

    it('is 500 followed accounts in production', async () => {
      expect(MAX_FOLLOWED_ACCOUNTS).toBe(500)
      const viewer = randomDid()
      const accounts = Array.from({ length: 502 }, () => randomDid())
      await fixture.seed([
        // Follow times run from the oldest follow to the newest.
        ...accounts.map((account, index) =>
          follow(viewer, account, minute(index)),
        ),
        ...accounts.map((account, index) =>
          post(account, 'p', minute(index + 1000)),
        ),
      ])

      const everything: string[] = []
      let cursor: string | undefined
      do {
        const page = await service.getFeedSkeleton(
          request(viewer, {
            limit: 50,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        )
        everything.push(...page.feed.map(({ subject }) => subject))
        cursor = page.cursor
      } while (cursor !== undefined)

      // The two oldest follows fall outside the cap.
      expect(everything).toHaveLength(500)
      expect(everything).not.toContain(uriOf(post(accounts[0] ?? '', 'p', '')))
      expect(everything).not.toContain(uriOf(post(accounts[1] ?? '', 'p', '')))
      expect(everything).toContain(uriOf(post(accounts[2] ?? '', 'p', '')))
    })
  })

  describe('audio', () => {
    it("shows a recording another account stored in a followed account's folder, under the folder's owner", async () => {
      const organizationDid = randomDid()
      const member = randomDid()
      const viewerOfOrganization = randomDid()
      const viewerOfMember = randomDid()
      const folder = folderUri(organizationDid, 'f')
      await fixture.seed([
        folderRecord(organizationDid, 'f'),
        audio(member, 'member1', minute(1), folder),
        audio(member, 'member2', minute(2), folder),
        audio(organizationDid, 'org1', minute(3), folder),
        follow(viewerOfOrganization, organizationDid),
        follow(viewerOfMember, member),
      ])

      const organizationFeed = await feedOf(viewerOfOrganization)
      const memberFeed = await feedOf(viewerOfMember)

      expect(labels(organizationFeed)).toEqual([
        'audio(3):org1,member2,member1',
      ])
      expect(organizationFeed.feed[0]).toMatchObject({
        did: organizationDid,
        deployment: folder,
      })
      // A follower of the account that stored recordings in someone else's
      // folder does not see them.
      expect(memberFeed).toEqual({ feed: [] })
    })

    it('shows a recording as a record that names the account that stored it', async () => {
      const organizationDid = randomDid()
      const member = randomDid()
      const viewer = randomDid()
      await fixture.seed([
        folderRecord(organizationDid, 'f'),
        audio(member, 'member1', minute(1), folderUri(organizationDid, 'f')),
        follow(viewer, organizationDid),
      ])

      const output = await feedOf(viewer)

      expect(labels(output)).toEqual(['audio:member1'])
      expect(output.feed[0]).toMatchObject({ did: member })
    })

    it('leaves out a recording a followed account stored in a folder nobody followed owns', async () => {
      const viewer = randomDid()
      const member = randomDid()
      const elsewhere = randomDid()
      await fixture.seed([
        follow(viewer, member),
        folderRecord(elsewhere, 'f'),
        audio(member, 'in-their-folder', minute(1), folderUri(elsewhere, 'f')),
        audio(member, 'own', minute(2)),
      ])

      expect(labels(await feedOf(viewer))).toEqual(['audio:own'])
    })

    it("shows a followed account's recordings without a folder, in its own folder, and in a folder named by a handle", async () => {
      const viewer = randomDid()
      const recorder = randomDid()
      await fixture.seed([
        follow(viewer, recorder),
        audio(recorder, 'none', minute(1)),
        audio(recorder, 'own-existing', minute(2), folderUri(recorder, 'f1')),
        folderRecord(recorder, 'f1'),
        // The folder record does not exist: the account still owns it.
        audio(recorder, 'own-dangling', minute(3), folderUri(recorder, 'f2')),
        audio(
          recorder,
          'handle',
          minute(4),
          'at://alice.example/app.gainforest.ac.deployment/f3',
        ),
        audio(recorder, 'not-an-at-uri', minute(5), 'https://example.org/f'),
        audio(recorder, 'bad-did', minute(6), 'at://did:/x/y'),
      ])

      expect(labels(await feedOf(viewer))).toEqual([
        'audio:bad-did',
        'audio:not-an-at-uri',
        'audio:handle',
        'audio:own-dangling',
        'audio:own-existing',
        'audio:none',
      ])
    })

    it('shows a recording a followed account stored in the folder of another followed account', async () => {
      const viewer = randomDid()
      const [owner, member] = [randomDid(), randomDid()]
      await fixture.seed([
        follow(viewer, owner),
        follow(viewer, member),
        folderRecord(owner, 'f'),
        audio(member, 'm1', minute(1), folderUri(owner, 'f')),
      ])

      expect(labels(await feedOf(viewer))).toEqual(['audio:m1'])
      expect(await feedOf(viewer)).toMatchObject({
        feed: [{ did: member }],
      })
    })

    // A recording belongs to a folder owner through a folder that exists. The
    // statement finds the recordings other accounts stored through the folders
    // a followed account owns, because nothing indexes `deploymentRef`.
    it.each([
      ['does not exist', undefined],
      ['is not valid', 'invalid'],
      ['is another type of record', 'other-collection'],
    ])(
      'leaves out a recording another account stored in a folder that %s',
      async (_name, problem) => {
        const viewer = randomDid()
        const owner = randomDid()
        const member = randomDid()
        const folder = folderUri(owner, 'f')
        await fixture.seed([
          follow(viewer, owner),
          audio(member, 'm1', minute(1), folder),
          ...(problem === undefined
            ? []
            : problem === 'invalid'
              ? [{ ...folderRecord(owner, 'f'), validation: 'invalid' }]
              : [{ ...folderRecord(owner, 'f'), collection: ORGANIZATION }]),
        ])

        const output = await feedOf(viewer)

        // The only thing the followed account stores that can be shown is the
        // organization record posing as a folder.
        expect(output.feed.map((item) => item.$type)).not.toContain(
          'app.gainforest.feed.defs#groupItem',
        )
        expect(
          labels(output).filter((entry) => entry.startsWith('audio')),
        ).toEqual([])
      },
    )

    it('needs the folder to be owned by a followed account, not merely stored by one', async () => {
      const viewer = randomDid()
      const followed = randomDid()
      const owner = randomDid()
      const member = randomDid()
      await fixture.seed([
        follow(viewer, followed),
        // A followed account stores a deployment record under another
        // owner's URI; the URI's authority is not the followed account.
        folderRecord(followed, 'f'),
        audio(member, 'm1', minute(1), folderUri(owner, 'f')),
      ])

      await expect(feedOf(viewer)).resolves.toEqual({ feed: [] })
    })

    it('skips the walk through the audio collection for a viewer whose follows own no folder, and runs it for one whose follows do', async () => {
      const viewer = randomDid()
      const folderless = randomDid()
      const recorder = randomDid()
      const owner = randomDid()
      const ownerViewer = randomDid()
      await fixture.seed([
        follow(viewer, folderless),
        post(folderless, 'p1', minute(1)),
        follow(ownerViewer, owner),
        folderRecord(owner, 'f'),
        ...Array.from({ length: 40 }, (_, index) =>
          audio(recorder, `a${String(index)}`, minute(index + 2)),
        ),
      ])
      const counted = countingService()

      await counted.service.getFeed(request(viewer))
      const skipped = await scansRunByCte(
        counted.lastStatement(),
        'folder_audio',
      )
      await counted.service.getFeed(request(ownerViewer))
      const walked = await scansRunByCte(
        counted.lastStatement(),
        'folder_audio',
      )

      expect(skipped).toBe(0)
      expect(walked).toBeGreaterThan(0)
    })

    // The flag of a bioacoustic sighting is read by primary key for the
    // observations of the batch. A row of another kind must not cost a lookup:
    // its key is NULL, which reads no page.
    it('looks up the sidecar of observations only', async () => {
      const viewer = randomDid()
      const recorder = randomDid()
      const naturalist = randomDid()
      await fixture.seed([
        follow(viewer, recorder),
        follow(viewer, naturalist),
        ...Array.from({ length: 12 }, (_, index) =>
          audio(recorder, `a${String(index)}`, minute(index + 1)),
        ),
        ...Array.from({ length: 6 }, (_, index) =>
          observation(naturalist, `o${String(index)}`, minute(index + 100)),
        ),
      ])
      const counted = countingService()

      await counted.service.getFeed(request(viewer, { filter: 'audio' }))
      const audioOnly = await sidecarLookupOf(counted.lastStatement())
      await counted.service.getFeed(request(viewer, { filter: 'observation' }))
      const observationsOnly = await sidecarLookupOf(counted.lastStatement())

      // Every row of the first batch is a recording: the lookup runs for each
      // of them and reads nothing. The second batch's rows are observations,
      // and each lookup reads the observation's page.
      expect(audioOnly.length).toBeGreaterThan(0)
      expect(audioOnly.map(({ buffers }) => buffers)).toEqual(
        audioOnly.map(() => 0),
      )
      expect(observationsOnly.length).toBeGreaterThan(0)
      expect(
        Math.max(...observationsOnly.map(({ buffers }) => buffers)),
      ).toBeGreaterThan(0)
    })

    it('reads all recordings when the followed accounts store too few rows to bound the walk', async () => {
      const viewer = randomDid()
      const owner = randomDid()
      const recorder = randomDid()
      await fixture.seed([
        follow(viewer, owner),
        folderRecord(owner, 'f'),
        ...Array.from({ length: 12 }, (_, index) =>
          audio(
            recorder,
            `a${String(index)}`,
            minute(index),
            index === 0 ? folderUri(owner, 'f') : undefined,
          ),
        ),
      ])
      const counted = countingService({ batchRows: 5, requestRows: 5 })

      const page = await counted.service.getFeed(request(viewer))

      expect(labels(page)).toEqual(['audio:a0'])
    })
  })

  describe('viewer binding through the HTTP application', () => {
    const post_ = (
      path: string,
      body: unknown,
      authorization?: string,
    ): Request =>
      new Request(`http://localhost/xrpc/app.gainforest.feed.${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: JSON.stringify(body),
      })

    const appFor = (credentials: ServiceAuthCredentials | undefined) =>
      createApp(
        { checkCompatibility: () => Promise.resolve({ compatible: true }) },
        { skeleton: service, feed: service },
        metrics,
        pino({ enabled: false }),
        authFor(credentials),
      )

    const seedTwoViewers = async () => {
      const [alice, bob, a, b] = [
        randomDid(),
        randomDid(),
        randomDid(),
        randomDid(),
      ]
      await fixture.seed([
        follow(alice, a),
        follow(bob, b),
        post(a, 'by-a', minute(1)),
        post(b, 'by-b', minute(2)),
      ])
      return { alice, bob }
    }

    it.each(['getFeed', 'getFeedSkeleton'] as const)(
      'serves the authenticated caller their own follows on %s, whatever params say',
      async (procedure) => {
        const { alice } = await seedTwoViewers()
        const app = appFor(credentialsOf(alice))

        for (const body of [
          { feedId: FOLLOWING_FEED_ID },
          {
            feedId: FOLLOWING_FEED_ID,
            params: { $type: FOLLOWING_FEED_PARAMS_TYPE },
          },
          {
            feedId: FOLLOWING_FEED_ID,
            params: { $type: FOLLOWING_FEED_PARAMS_TYPE, viewerDid: alice },
          },
        ]) {
          const response = await app.fetch(
            post_(procedure, body, 'Bearer token'),
          )
          expect(response.status).toBe(200)
          const json = JSON.stringify(await response.json())
          expect(json).toContain('by-a')
          expect(json).not.toContain('by-b')
        }
      },
    )

    it.each(['getFeed', 'getFeedSkeleton'] as const)(
      'does not let an authenticated caller read another account’s following feed on %s',
      async (procedure) => {
        const { alice, bob } = await seedTwoViewers()
        const app = appFor(credentialsOf(alice))

        const response = await app.fetch(
          post_(
            procedure,
            {
              feedId: FOLLOWING_FEED_ID,
              params: { $type: FOLLOWING_FEED_PARAMS_TYPE, viewerDid: bob },
            },
            'Bearer token',
          ),
        )

        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toMatchObject({
          error: 'InvalidRequest',
        })
      },
    )

    it.each(['getFeed', 'getFeedSkeleton'] as const)(
      'serves an anonymous caller the viewer they name on %s, and asks for one otherwise',
      async (procedure) => {
        const { bob } = await seedTwoViewers()
        const app = appFor(undefined)

        const named = await app.fetch(
          post_(procedure, {
            feedId: FOLLOWING_FEED_ID,
            params: { $type: FOLLOWING_FEED_PARAMS_TYPE, viewerDid: bob },
          }),
        )
        expect(named.status).toBe(200)
        const json = JSON.stringify(await named.json())
        expect(json).toContain('by-b')
        expect(json).not.toContain('by-a')

        for (const body of [
          { feedId: FOLLOWING_FEED_ID },
          {
            feedId: FOLLOWING_FEED_ID,
            params: { $type: FOLLOWING_FEED_PARAMS_TYPE, filter: 'post' },
          },
        ]) {
          const missing = await app.fetch(post_(procedure, body))
          expect(missing.status).toBe(400)
          await expect(missing.json()).resolves.toMatchObject({
            error: 'InvalidRequest',
          })
        }
      },
    )

    it.each(['getFeed', 'getFeedSkeleton'] as const)(
      'leaves the activity feed independent of the caller and of the viewer on %s',
      async (procedure) => {
        const { alice } = await seedTwoViewers()

        const anonymous = await appFor(undefined).fetch(
          post_(procedure, {
            feedId: ACTIVITY_FEED_ID,
            params: {
              $type: ACTIVITY_FEED_PARAMS_TYPE,
              following: true,
              viewerDid: alice,
            },
          }),
        )
        const authenticated = await appFor(credentialsOf(alice)).fetch(
          post_(procedure, { feedId: ACTIVITY_FEED_ID }, 'Bearer token'),
        )

        expect(anonymous.status).toBe(200)
        expect(authenticated.status).toBe(200)
        const both = (await anonymous.json()) as unknown
        expect(both).toEqual(await authenticated.json())
        const json = JSON.stringify(both)
        expect(json).toContain('by-a')
        expect(json).toContain('by-b')
      },
    )
  })

  describe('cursors', () => {
    it('continues the following feed strictly after the last row of the previous page', async () => {
      const viewer = randomDid()
      const followed = randomDid()
      await fixture.seed([
        follow(viewer, followed),
        ...Array.from({ length: 9 }, (_, index) =>
          post(followed, `p${String(index)}`, minute(index + 1)),
        ),
      ])

      const pages = await walk(viewer, undefined, 4)

      expect(pages.map(labels)).toEqual([
        ['post:p8', 'post:p7', 'post:p6', 'post:p5'],
        ['post:p4', 'post:p3', 'post:p2', 'post:p1'],
        ['post:p0'],
      ])
      expect(pages.at(-1)?.cursor).toBeUndefined()
    })

    it('rejects a cursor of the other feed, over HTTP too', async () => {
      const viewer = randomDid()
      const followed = randomDid()
      await fixture.seed([
        follow(viewer, followed),
        ...Array.from({ length: 4 }, (_, index) =>
          post(followed, `p${String(index)}`, minute(index + 1)),
        ),
      ])
      const followingPage = await service.getFeed(request(viewer, { limit: 2 }))
      const activityPage = await service.getFeed(activityRequest({ limit: 2 }))
      expect(followingPage.cursor).toBeDefined()
      expect(activityPage.cursor).toBeDefined()

      await expect(
        service.getFeed(
          request(viewer, { cursor: defined(activityPage.cursor) }),
        ),
      ).rejects.toMatchObject({ code: 'InvalidCursor' })
      await expect(
        service.getFeedSkeleton(
          activityRequest({ cursor: defined(followingPage.cursor) }),
        ),
      ).rejects.toMatchObject({ code: 'InvalidCursor' })

      const app = createApp(
        { checkCompatibility: () => Promise.resolve({ compatible: true }) },
        { skeleton: service, feed: service },
        metrics,
        pino({ enabled: false }),
      )
      const response = await app.fetch(
        new Request('http://localhost/xrpc/app.gainforest.feed.getFeed', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            activityRequest({ cursor: defined(followingPage.cursor) }),
          ),
        }),
      )
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        error: 'InvalidCursor',
      })
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

    const viewer = `did:plc:${'v'.repeat(24)}`
    const stranger = `did:plc:${'s'.repeat(24)}`
    const webOwner = 'did:web:recorders.example'
    // Accounts 0 and 2 and the did:web owner are followed; 1 and 3 are not.
    const dids = [
      `did:plc:${'a'.repeat(24)}`,
      `did:plc:${'b'.repeat(24)}`,
      `did:plc:${'c'.repeat(24)}`,
      `did:plc:${'d'.repeat(24)}`,
    ] as const
    const followedDids = [dids[0], dids[2], webOwner]
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
     * Dense data in the shape of the activity feed's comparisons: sessions
     * around the 12-hour gap and streaks of one account, in which recordings
     * are stored by one account in the folders of others, folders exist or do
     * not, and follows are valid, invalid, malformed, or someone else's. With
     * `ties`, about a third of the rows share the previous row's timestamp.
     */
    const randomDataset = (seed: number, ties: boolean): SeedRecord[] => {
      const next = random(seed)
      const pick = <T>(values: readonly [T, ...T[]]): T =>
        values[Math.floor(next() * values.length)] ?? values[0]
      const folders = [
        undefined,
        folderUri(dids[0], 'f1'),
        folderUri(dids[1], 'f2'),
        folderUri(webOwner, 'f4'),
        // Followed owner, folder record missing.
        folderUri(dids[2], 'f6'),
        'at://alice.example/app.gainforest.ac.deployment/f3',
        'at://did:/app.gainforest.ac.deployment/f5',
      ] as const
      const records: SeedRecord[] = [
        // The folders that exist; f2 is not valid, and f6 is not stored.
        folderRecord(dids[0], 'f1'),
        { ...folderRecord(dids[1], 'f2'), validation: 'invalid' },
        folderRecord(webOwner, 'f4'),
        folderRecord(dids[2], 'f7'),
        // The follows. Subject 3 is followed by a follow Hyperindex rejected,
        // 1 only by another viewer, and one follow has no string subject.
        ...followedDids.map((did, index) =>
          follow(viewer, did, minute(index + 1)),
        ),
        // The did:web owner is followed twice, the second time after the
        // others, so a cap on follow records and a cap on accounts differ.
        { ...follow(viewer, webOwner, minute(4)), rkey: 'follow-again' },
        { ...follow(viewer, dids[3]), validation: 'invalid' },
        follow(stranger, dids[1]),
        {
          did: viewer,
          collection: FOLLOW,
          rkey: 'odd',
          createdAt: minute(0),
          json: { subject: 7 },
        },
      ]
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
          clock += 12 * 3_600_000
        } else if (roll < 0.97) {
          clock += 12 * 3_600_000 + 1
        } else {
          clock += 3 * 3_600_000
        }
        return new Date(clock).toISOString()
      }
      const account = (): string => pick([...dids, webOwner, stranger])

      const session = (): void => {
        const did = account()
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

      let lastDid = account()
      let lastRoll = next()
      let lastFolder = pick(folders)
      for (let step = 0; step < 260; step += 1) {
        if (next() < 0.04) {
          session()
          continue
        }
        const sticky = next() < 0.6
        const did = sticky ? lastDid : account()
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
     * Pages the following feed to the end and compares every page with the
     * model: its items, whether it has a cursor, the statements the request
     * sent, and the skeleton of the same page.
     */
    const expectModelFeed = async (
      records: readonly SeedRecord[],
      sizes: FollowingFeedOptions,
    ): Promise<void> => {
      const uriRank = await fixture.uriOrder(records.map(uriOf))
      const counted = countingService(sizes)
      for (const filter of [
        'all',
        'project',
        'observation',
        'organization',
        'post',
        'audio',
      ]) {
        for (const limit of [1, 3, 7, 20, 50]) {
          const expected = modelPages(records, {
            filter,
            limit,
            uriRank,
            following: {
              viewer,
              ...(sizes.maxFollowedAccounts === undefined
                ? {}
                : { maxFollowedAccounts: sizes.maxFollowedAccounts }),
            },
            ...(sizes.batchRows === undefined
              ? {}
              : { batchRows: sizes.batchRows }),
            ...(sizes.requestRows === undefined
              ? {}
              : { requestRows: sizes.requestRows }),
          })
          let cursor: string | undefined
          for (const [index, page] of expected.entries()) {
            const where = `filter ${filter}, limit ${String(limit)}, page ${String(index + 1)}`
            const input = request(viewer, {
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

    it('has data rich enough for the comparisons to cover every scope rule', () => {
      const records = randomDataset(1, true)
      const everything = modelRowUris(records, { filter: 'all' }).length
      const followed = modelRowUris(records, {
        filter: 'all',
        following: { viewer },
      }).length
      const pages = modelPages(records, {
        filter: 'all',
        limit: 3,
        batchRows: 3,
        requestRows: 13,
        following: { viewer },
      })
      const items = pages.flatMap((page) => page.items)

      // The scope removes much but not most of the feed.
      expect(followed).toBeGreaterThan(50)
      expect(followed).toBeLessThan(everything * 0.8)
      for (const kind of ['observation', 'audio']) {
        expect(
          items.some((item) => item.type === 'group' && item.kind === kind),
          `a ${kind} group`,
        ).toBe(true)
      }
      expect(items.some((item) => item.type === 'repost')).toBe(true)
      expect(pages.some((page) => page.items.length > 3)).toBe(true)

      // Recordings in a followed folder that another account stored, and
      // recordings a followed account stored in a folder it does not own.
      const folderRows = records.filter(
        (record) =>
          record.collection === AUDIO &&
          record.json?.deploymentRef === folderUri(dids[0], 'f1'),
      )
      const selected = new Set(
        modelRowUris(records, { filter: 'audio', following: { viewer } }),
      )
      expect(
        folderRows.some(
          (record) =>
            record.did !== dids[0] &&
            record.validation !== 'invalid' &&
            selected.has(uriOf(record)),
        ),
      ).toBe(true)
      expect(
        records.some(
          (record) =>
            record.collection === AUDIO &&
            record.did === dids[0] &&
            record.json?.deploymentRef === folderUri(dids[1], 'f2') &&
            !selected.has(uriOf(record)),
        ),
      ).toBe(true)
    })

    it('lists every selectable row exactly once across a full walk, at several limits and budgets', async () => {
      const records = randomDataset(5, false)
      await fixture.seed(records)
      const uriRank = await fixture.uriOrder(records.map(uriOf))
      const everything = modelRowUris(records, {
        filter: 'all',
        uriRank,
        following: { viewer },
      }).sort()
      expect(everything.length).toBeGreaterThan(50)

      for (const sizes of [
        {},
        { batchRows: 7, requestRows: 25 },
        { batchRows: 1, requestRows: 4 },
      ] satisfies FollowingFeedOptions[]) {
        const reader = serviceFor(sizes)
        for (const limit of [1, 3, 20, 50]) {
          const context = `${JSON.stringify(sizes)}, limit ${String(limit)}`
          const uris: string[] = []
          let cursor: string | undefined
          do {
            const page = await reader.getFeedSkeleton(
              request(viewer, {
                limit,
                ...(cursor === undefined ? {} : { cursor }),
              }),
            )
            uris.push(...page.feed.map(({ subject }) => subject))
            cursor = page.cursor
          } while (cursor !== undefined)
          expect([...uris].sort(), context).toEqual(everything)

          const items = (await walk(viewer, undefined, limit, reader)).flatMap(
            (page) => page.feed,
          )
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
        seeds: [1, 2],
      },
      {
        name: 'production sizes, tied timestamps',
        ties: true,
        sizes: {},
        seeds: [1],
      },
      {
        name: 'batches of 7 rows and a budget of 40, unique timestamps',
        ties: false,
        sizes: { batchRows: 7, requestRows: 40 },
        seeds: [1, 2],
      },
      {
        name: 'batches of 3 rows and a budget of 13, tied timestamps',
        ties: true,
        sizes: { batchRows: 3, requestRows: 13 },
        seeds: [1, 2],
      },
      {
        name: 'one-row batches and a budget of 9, unique timestamps',
        ties: false,
        sizes: { batchRows: 1, requestRows: 9 },
        seeds: [1],
      },
      {
        name: 'a budget that is not a multiple of the batch, tied timestamps',
        ties: true,
        sizes: { batchRows: 4, requestRows: 10 },
        seeds: [1],
      },
      {
        name: 'a cap of two followed accounts, batches of 7 rows',
        ties: false,
        sizes: { maxFollowedAccounts: 2, batchRows: 7, requestRows: 40 },
        seeds: [1, 2],
      },
    ] as const satisfies readonly {
      name: string
      ties: boolean
      sizes: FollowingFeedOptions
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
