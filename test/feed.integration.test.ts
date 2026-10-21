import { randomBytes } from 'node:crypto'

import pino from 'pino'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'
import { Database } from '../src/database.js'
import { createHypercertsFeed } from '../src/feed/query.js'
import { FeedRegistry } from '../src/feed/registry.js'
import { FeedService } from '../src/feed/service.js'
import {
  HYPERCERTS_FEED_ID,
  HYPERCERTS_FEED_PARAMS_TYPE,
  type HypercertsFeedParams,
  type GetFeedSkeletonInput,
} from '../src/feed/types.js'
import { PostgresIdentityReader } from '../src/hydration/identity.js'
import { Metrics } from '../src/metrics.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
if (TEST_DATABASE_URL === undefined || TEST_DATABASE_URL.length === 0) {
  throw new Error(
    'TEST_DATABASE_URL is required for integration tests; point it at an empty disposable Postgres 16+ database.',
  )
}
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const staleCid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72a'
const plcAlphabet = 'abcdefghijklmnopqrstuvwxyz234567'

const randomDid = (): string => {
  const bytes = randomBytes(24)
  let suffix = ''
  for (const byte of bytes) {
    suffix += plcAlphabet.charAt(byte % plcAlphabet.length)
  }
  return `did:plc:${suffix}`
}

describe('Hypercerts feed definition against Postgres', () => {
  const logger = pino({ enabled: false })
  let admin: Pool | undefined
  let database: Database | undefined
  let identities: PostgresIdentityReader
  let pages: FeedRegistry
  let service: FeedService

  const getAdmin = (): Pool => {
    if (admin === undefined) {
      throw new Error('PostgreSQL integration fixtures are not initialized')
    }
    return admin
  }

  const getDatabase = (): Database => {
    if (database === undefined) {
      throw new Error('PostgreSQL integration fixtures are not initialized')
    }
    return database
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: TEST_DATABASE_URL })
    await admin.query(`
      CREATE TABLE IF NOT EXISTS happyview_records (
        uri text PRIMARY KEY NOT NULL,
        did text NOT NULL,
        collection text NOT NULL,
        rkey text NOT NULL,
        record text NOT NULL,
        cid text NOT NULL,
        indexed_at text,
        created_at text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS happyview_labels (
        src text NOT NULL,
        uri text NOT NULL,
        val text NOT NULL,
        cts text NOT NULL,
        exp text,
        PRIMARY KEY (src, uri, val)
      );
    `)

    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      SERVICE_DID: 'did:web:feed.example',
      DATABASE_MAX_CONNECTIONS: '3',
      DATABASE_STATEMENT_TIMEOUT_MS: '10000',
    })
    database = new Database(config, logger)
    identities = new PostgresIdentityReader(getDatabase())
    pages = createPages()
    service = new FeedService(pages)
  })

  afterAll(async () => {
    if (database !== undefined) await database.close()
    if (admin !== undefined) await admin.end()
  })

  const seedDidOnlyProfile = async (did: string): Promise<void> => {
    await seedRecord(
      did,
      'app.certified.actor.profile',
      'self',
      {
        $type: 'app.certified.actor.profile',
        createdAt: '2026-07-20T00:00:00Z',
      },
      '2026-07-20T00:00:00Z',
    )
  }

  const seedRecord = async (
    did: string,
    collection: string,
    rkey: string,
    body: Record<string, unknown> | string,
    effectiveAt: string,
    options: {
      readonly cid?: string
      readonly indexedAt?: string | null
    } = {},
  ): Promise<string> => {
    const uri = `at://${did}/${collection}/${rkey}`
    const indexedAt =
      options.indexedAt === undefined ? effectiveAt : options.indexedAt
    const recordText = typeof body === 'string' ? body : JSON.stringify(body)
    await getAdmin().query(
      `INSERT INTO happyview_records (
         uri, did, collection, rkey, record, cid, indexed_at, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-07-20 00:00:00+00')`,
      [uri, did, collection, rkey, recordText, options.cid ?? cid, indexedAt],
    )
    return uri
  }

  const seedFollow = async (
    viewerDid: string,
    subjectDid: string,
  ): Promise<void> => {
    await seedRecord(
      viewerDid,
      'app.certified.graph.follow',
      `follow-${randomBytes(8).toString('hex')}`,
      { subject: subjectDid },
      '2026-07-20T00:00:00Z',
    )
  }

  type HypercertsFeedOverrides = Omit<
    HypercertsFeedParams,
    '$type' | 'viewerDid'
  > &
    Pick<GetFeedSkeletonInput, 'limit' | 'cursor'>

  const createPages = (
    trustedQualityLabelerDids: readonly string[] = [],
  ): FeedRegistry =>
    new FeedRegistry([
      createHypercertsFeed(
        { database: getDatabase(), metrics: new Metrics() },
        trustedQualityLabelerDids,
      ),
    ])

  const feedRequest = (
    viewerDid: string,
    input: HypercertsFeedOverrides = {},
  ): GetFeedSkeletonInput => {
    const { limit, cursor, ...params } = input
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

  const getFeedForFollows = async (
    followedDids: readonly string[],
    input: HypercertsFeedOverrides = {},
  ) => {
    const viewerDid = randomDid()
    await seedDidOnlyProfile(viewerDid)
    await Promise.all(followedDids.map((did) => seedFollow(viewerDid, did)))
    return service.getFeedSkeleton(feedRequest(viewerDid, input))
  }

  const seedOrganization = async (
    did: string,
    effectiveAt = '2026-07-19T00:00:00Z',
  ): Promise<string> =>
    seedRecord(
      did,
      'app.certified.actor.organization',
      'self',
      { $type: 'app.certified.actor.organization' },
      effectiveAt,
    )

  const seedHappyViewLabel = async (
    src: string,
    uri: string,
    val: string,
    options: {
      readonly cts?: string
      readonly exp?: string | null
    } = {},
  ): Promise<void> => {
    await getAdmin().query(
      `INSERT INTO happyview_labels (src, uri, val, cts, exp)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (src, uri, val) DO UPDATE
       SET cts = EXCLUDED.cts, exp = EXCLUDED.exp`,
      [
        src,
        uri,
        val,
        options.cts ?? '2026-07-20 00:00:00+00',
        options.exp ?? null,
      ],
    )
  }

  it('passes readiness capability checks and rejects writes from the service pool', async () => {
    await expect(getDatabase().checkCompatibility()).resolves.toEqual({
      compatible: true,
    })
    const did = randomDid()
    await expect(
      getDatabase().query(
        `INSERT INTO happyview_records (
           uri, did, collection, rkey, record, cid, indexed_at, created_at
         )
         VALUES ($1, $2, $3, $4, '{}', $5, '2026-07-20 00:00:00+00', '2026-07-20 00:00:00+00')`,
        [
          `at://${did}/org.hypercerts.claim.activity/read-only`,
          did,
          'org.hypercerts.claim.activity',
          'read-only',
          cid,
        ],
      ),
    ).rejects.toThrow(/read-only/i)
  })

  it('loads metadata and exact source pages from the same statement contract', async () => {
    const viewer = randomDid()
    const author = randomDid()
    const selectedBody = {
      $type: 'org.hypercerts.claim.activity',
      marker: 'selected-source-body',
      createdAt: '2026-07-20T00:00:02Z',
    }
    await Promise.all([seedDidOnlyProfile(viewer), seedDidOnlyProfile(author)])
    await seedFollow(viewer, author)
    const selectedUri = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'source-page-selected',
      selectedBody,
      '2026-07-20T00:00:02Z',
    )
    await seedRecord(
      author,
      'org.hypercerts.collection',
      'source-page-sentinel',
      {
        $type: 'org.hypercerts.collection',
        marker: 'limit-plus-one-sentinel',
        createdAt: '2026-07-20T00:00:01Z',
      },
      '2026-07-20T00:00:01Z',
      { cid: staleCid },
    )
    const request = feedRequest(viewer, { limit: 1 })

    const metadata = await pages.loadPage(request, 'metadata')
    const withSource = await pages.loadPage(request, 'with-source')

    expect(metadata.rows).toEqual([
      {
        uri: selectedUri,
        cid,
        actorDid: author,
        collection: 'org.hypercerts.claim.activity',
        kind: 'cert.create',
        sortValue: '2026-07-20T00:00:02.000000Z',
      },
    ])
    expect(metadata.rows[0]).not.toHaveProperty('sourceValue')
    expect(withSource.rows).toEqual([
      {
        ...metadata.rows[0],
        sourceValue: selectedBody,
      },
    ])
    expect(withSource.cursor).toBe(metadata.cursor)
    expect(metadata.cursor).toBeDefined()
  })

  it('reads only current Certified profiles and returns DID-only fallbacks', async () => {
    const actorWithProfiles = randomDid()
    const blueskyOnly = randomDid()
    const missingIdentity = randomDid()
    const wrongCollection = randomDid()
    const staleCertified = { marker: 'stale-certified-self' }
    const currentCertified = { marker: 'current-certified-self' }
    const blueskyBody = { marker: 'bluesky-self' }
    const certifiedUri = `at://${actorWithProfiles}/app.certified.actor.profile/self`

    await seedRecord(
      actorWithProfiles,
      'app.certified.actor.profile',
      'self',
      staleCertified,
      '2026-07-20T00:00:00Z',
    )
    await seedRecord(
      actorWithProfiles,
      'app.bsky.actor.profile',
      'self',
      blueskyBody,
      '2026-07-20T00:00:00Z',
    )
    await seedRecord(
      blueskyOnly,
      'app.bsky.actor.profile',
      'self',
      blueskyBody,
      '2026-07-20T00:00:00Z',
    )
    await seedRecord(
      wrongCollection,
      'org.hypercerts.collection',
      'self',
      { marker: 'not-a-profile' },
      '2026-07-20T00:00:00Z',
    )
    await getAdmin().query(
      `UPDATE happyview_records
       SET cid = $2, record = $3
       WHERE uri = $1`,
      [certifiedUri, staleCid, JSON.stringify(currentCertified)],
    )

    await expect(
      identities.getByDids([
        actorWithProfiles,
        blueskyOnly,
        missingIdentity,
        wrongCollection,
        actorWithProfiles,
      ]),
    ).resolves.toEqual(
      new Map([
        [
          actorWithProfiles,
          { did: actorWithProfiles, certifiedProfile: currentCertified },
        ],
        [blueskyOnly, { did: blueskyOnly }],
        [missingIdentity, { did: missingIdentity }],
        [wrongCollection, { did: wrongCollection }],
      ]),
    )
  })

  it('resolves follows and evaluators, applies quality, and classifies before filtering', async () => {
    const viewer = randomDid()
    const trustedLabeler = randomDid()
    const followedOrg = randomDid()
    const blockedOrg = randomDid()
    const purgedAccount = randomDid()
    const evaluator = randomDid()
    const endorsedPersonWithoutActor = randomDid()
    const awardSubject = randomDid()
    const malformedAccount = `invalid-${randomBytes(8).toString('hex')}`

    await Promise.all([
      seedDidOnlyProfile(viewer),
      seedDidOnlyProfile(followedOrg),
      seedDidOnlyProfile(blockedOrg),
      seedDidOnlyProfile(evaluator),
      seedDidOnlyProfile(awardSubject),
      seedOrganization(followedOrg),
      seedOrganization(blockedOrg),
    ])

    for (const [index, subject] of [
      followedOrg,
      blockedOrg,
      purgedAccount,
    ].entries()) {
      await seedRecord(
        viewer,
        'app.certified.graph.follow',
        `follow-${String(index)}`,
        { subject },
        `2026-07-20T00:00:0${String(index)}Z`,
      )
    }

    await seedHappyViewLabel(trustedLabeler, followedOrg, 'high-quality')
    await seedHappyViewLabel(trustedLabeler, blockedOrg, 'likely-test')
    await seedHappyViewLabel(randomDid(), blockedOrg, 'high-quality')
    await seedHappyViewLabel(
      trustedLabeler,
      `at://${blockedOrg}/app.certified.actor.organization/self`,
      'high-quality',
    )
    const definitionUri = await seedRecord(
      evaluator,
      'app.certified.badge.definition',
      'endorsement-definition',
      { badgeType: 'endorsement' },
      '2026-07-20T01:00:00Z',
    )
    await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'scope-award',
      {
        badge: { uri: definitionUri, cid },
        subject: {
          $type: 'app.certified.defs#did',
          did: endorsedPersonWithoutActor,
        },
      },
      '2026-07-20T01:00:01Z',
    )
    await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'malformed-scope-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: malformedAccount },
      },
      '2026-07-20T01:00:02Z',
    )
    await seedRecord(
      malformedAccount,
      'org.hypercerts.claim.activity',
      'must-not-enter-scope',
      { createdAt: '2026-07-21T14:00:00Z' },
      '2026-07-21T14:00:00Z',
    )

    const activityUri = await seedRecord(
      followedOrg,
      'org.hypercerts.claim.activity',
      'paired-activity',
      { createdAt: '2026-07-21T10:00:00Z' },
      '2026-07-21T10:00:00Z',
    )
    const collectionUri = await seedRecord(
      followedOrg,
      'org.hypercerts.collection',
      'project',
      {
        createdAt: '2026-07-21T10:00:10Z',
        items: [{ itemIdentifier: { uri: activityUri, cid } }],
      },
      '2026-07-21T10:00:10Z',
    )
    await seedRecord(
      followedOrg,
      'org.hypercerts.context.evaluation',
      'evaluation',
      { createdAt: '2026-07-21T11:00:00+00:00' },
      '2026-07-21T11:00:00Z',
      { indexedAt: '2026-07-21T09:00:00Z' },
    )
    await seedRecord(
      followedOrg,
      'org.hypercerts.context.attachment',
      'update',
      { contentType: 'update', createdAt: '2026-07-21T09:00:00Z' },
      '2026-07-21T09:00:00Z',
    )
    await seedRecord(
      followedOrg,
      'org.hypercerts.context.attachment',
      'audit',
      { contentType: 'audit', createdAt: '2026-07-21T08:30:00Z' },
      '2026-07-21T08:30:00Z',
    )
    const dateOnlyUri = await seedRecord(
      followedOrg,
      'org.hypercerts.context.measurement',
      'date-only-created-at',
      { createdAt: '2026-07-22' },
      '2026-07-21T07:30:00Z',
    )
    await seedRecord(
      blockedOrg,
      'org.hypercerts.claim.activity',
      'blocked',
      { createdAt: '2026-07-21T12:00:00Z' },
      '2026-07-21T12:00:00Z',
    )
    const endorsedUri = await seedRecord(
      endorsedPersonWithoutActor,
      'org.hypercerts.claim.activity',
      'endorsed',
      { createdAt: '2026-07-21T07:00:00Z' },
      '2026-07-21T07:00:00Z',
    )

    const feedDefinitionUri = await seedRecord(
      followedOrg,
      'app.certified.badge.definition',
      'feed-endorsement-definition',
      { badgeType: 'endorsement' },
      '2026-07-20T02:00:00Z',
    )
    const visibleAwardUri = await seedRecord(
      followedOrg,
      'app.certified.badge.award',
      'visible-award',
      {
        badge: { uri: feedDefinitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: awardSubject },
        createdAt: '2026-07-21T06:00:00Z',
      },
      '2026-07-21T06:00:00Z',
    )
    await seedRecord(
      followedOrg,
      'app.certified.badge.award',
      'malformed-subject-award',
      {
        badge: { uri: feedDefinitionUri, cid },
        subject: {
          $type: 'app.certified.defs#did',
          did: malformedAccount,
        },
        createdAt: '2026-07-21T05:30:00Z',
      },
      '2026-07-21T05:30:00Z',
    )
    await seedRecord(
      followedOrg,
      'app.certified.badge.award',
      'self-endorsement-award',
      {
        badge: { uri: feedDefinitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: followedOrg },
        createdAt: '2026-07-21T05:15:00Z',
      },
      '2026-07-21T05:15:00Z',
    )
    const rejectedAwardUri = await seedRecord(
      followedOrg,
      'app.certified.badge.award',
      'rejected-award',
      {
        badge: { uri: feedDefinitionUri, cid },
        subject: {
          $type: 'app.certified.defs#did',
          did: endorsedPersonWithoutActor,
        },
        createdAt: '2026-07-21T05:00:00Z',
      },
      '2026-07-21T05:00:00Z',
    )
    await seedRecord(
      endorsedPersonWithoutActor,
      'app.certified.badge.response',
      'rejection',
      { badgeAward: { uri: rejectedAwardUri, cid }, response: 'rejected' },
      '2026-07-21T05:01:00Z',
    )

    pages = createPages([trustedLabeler])
    service = new FeedService(pages)
    const request = feedRequest(viewer, {
      trustedEvaluators: [evaluator],
      organizationQuality: {
        allowed: ['high-quality'],
        includeUnrated: false,
      },
      limit: 50,
    })
    const output = await service.getFeedSkeleton(request)
    const metadata = await pages.loadPage(request, 'metadata')

    expect(metadata.rows.map((item) => item.kind)).toEqual([
      'evaluation.create',
      'project.created_with_cert',
      'update.create',
      'measurement.create',
      'cert.create',
      'endorsement.award',
    ])
    expect(output.feed.map((item) => item.subject)).toEqual([
      expect.stringContaining('/org.hypercerts.context.evaluation/'),
      collectionUri,
      expect.stringContaining('/org.hypercerts.context.attachment/update'),
      dateOnlyUri,
      endorsedUri,
      visibleAwardUri,
    ])
    expect(output.feed.some((item) => item.subject === activityUri)).toBe(false)
    expect(metadata.rows[0]?.sortValue).toBe('2026-07-21T11:00:00.000000Z')
    expect(
      metadata.rows.find((item) => item.uri === dateOnlyUri)?.sortValue,
    ).toBe('2026-07-21T07:30:00.000000Z')

    const projectOnly = await getFeedForFollows([followedOrg], {
      organizationQuality: {
        allowed: ['high-quality'],
        includeUnrated: false,
      },
      kinds: ['project.created_with_cert'],
    })
    expect(projectOnly.feed).toHaveLength(1)
    expect(projectOnly.feed[0]?.subject).toBe(collectionUri)
  })

  it('detects organizations only through the exact organization self record', async () => {
    const viewer = randomDid()
    const personWithNearMatch = randomDid()
    const organization = randomDid()
    await Promise.all([
      seedDidOnlyProfile(viewer),
      seedRecord(
        personWithNearMatch,
        'app.certified.actor.organization',
        'profile',
        { $type: 'app.certified.actor.organization' },
        '2026-07-21T00:00:00Z',
      ),
      seedOrganization(organization, '2026-07-21T00:00:01Z'),
    ])
    const personActivity = await seedRecord(
      personWithNearMatch,
      'org.hypercerts.claim.activity',
      'person-activity',
      { createdAt: '2026-07-21T01:00:00Z' },
      '2026-07-21T01:00:00Z',
    )
    await seedRecord(
      organization,
      'org.hypercerts.claim.activity',
      'organization-activity',
      { createdAt: '2026-07-21T02:00:00Z' },
      '2026-07-21T02:00:00Z',
    )

    const output = await getFeedForFollows(
      [personWithNearMatch, organization],
      {
        organizationQuality: {
          allowed: ['high-quality'],
          includeUnrated: false,
        },
      },
    )

    expect(output.feed.map((item) => item.subject)).toEqual([personActivity])
  })

  it('filters organizations using active trusted bare-DID HappyView labels', async () => {
    const trustedLabeler = randomDid()
    const untrustedLabeler = randomDid()
    const allowedOrg = randomDid()
    const disallowedOrg = randomDid()
    const expiredOrg = randomDid()
    const untrustedOrg = randomDid()
    const malformedExpiryOrg = randomDid()
    const dateOnlyExpiryOrg = randomDid()
    const infiniteExpiryOrg = randomDid()
    const infiniteCtsOrg = randomDid()
    const dateOnlyCtsOrg = randomDid()
    const recordLabelOrg = randomDid()
    const unratedOrg = randomDid()
    const organizations = [
      { did: allowedOrg, createdAt: '2026-07-21T12:00:00Z' },
      { did: disallowedOrg, createdAt: '2026-07-21T11:00:00Z' },
      { did: expiredOrg, createdAt: '2026-07-21T10:00:00Z' },
      { did: untrustedOrg, createdAt: '2026-07-21T09:00:00Z' },
      { did: malformedExpiryOrg, createdAt: '2026-07-21T08:30:00Z' },
      { did: recordLabelOrg, createdAt: '2026-07-21T08:00:00Z' },
      { did: dateOnlyExpiryOrg, createdAt: '2026-07-21T07:55:00Z' },
      { did: infiniteExpiryOrg, createdAt: '2026-07-21T07:45:00Z' },
      { did: infiniteCtsOrg, createdAt: '2026-07-21T07:30:00Z' },
      { did: dateOnlyCtsOrg, createdAt: '2026-07-21T07:15:00Z' },
      { did: unratedOrg, createdAt: '2026-07-21T07:00:00Z' },
    ]
    const activityUris = new Map<string, string>()

    await Promise.all(
      organizations.flatMap(({ did, createdAt }) => [
        seedOrganization(did),
        seedRecord(
          did,
          'org.hypercerts.claim.activity',
          'quality-projection',
          { createdAt },
          createdAt,
        ).then((uri) => activityUris.set(did, uri)),
      ]),
    )
    await seedHappyViewLabel(trustedLabeler, allowedOrg, 'high-quality')
    await seedHappyViewLabel(trustedLabeler, disallowedOrg, 'likely-test')
    await seedHappyViewLabel(trustedLabeler, expiredOrg, 'high-quality', {
      exp: '2000-01-01 00:00:00+00',
    })
    await seedHappyViewLabel(
      trustedLabeler,
      malformedExpiryOrg,
      'high-quality',
      { exp: 'not-a-timestamp' },
    )
    await seedHappyViewLabel(
      trustedLabeler,
      dateOnlyExpiryOrg,
      'high-quality',
      { exp: '2999-01-01' },
    )
    await seedHappyViewLabel(
      trustedLabeler,
      infiniteExpiryOrg,
      'high-quality',
      { exp: 'infinity' },
    )
    await seedHappyViewLabel(trustedLabeler, infiniteCtsOrg, 'high-quality', {
      cts: '-infinity',
    })
    await seedHappyViewLabel(trustedLabeler, dateOnlyCtsOrg, 'high-quality', {
      cts: '2999-01-01',
    })
    await seedHappyViewLabel(untrustedLabeler, untrustedOrg, 'high-quality')
    await seedHappyViewLabel(
      trustedLabeler,
      `at://${recordLabelOrg}/app.certified.actor.organization/self`,
      'high-quality',
    )

    pages = createPages([trustedLabeler])
    service = new FeedService(pages)
    const ratedOnly = await getFeedForFollows(
      organizations.map(({ did }) => did),
      {
        organizationQuality: {
          allowed: ['high-quality'],
          includeUnrated: false,
        },
      },
    )
    expect(ratedOnly.feed.map((item) => item.subject)).toEqual([
      activityUris.get(allowedOrg),
    ])

    const withUnrated = await getFeedForFollows(
      organizations.map(({ did }) => did),
      {
        organizationQuality: {
          allowed: ['high-quality'],
          includeUnrated: true,
        },
      },
    )
    expect(withUnrated.feed.map((item) => item.subject)).toEqual([
      activityUris.get(allowedOrg),
      activityUris.get(expiredOrg),
      activityUris.get(untrustedOrg),
      activityUris.get(malformedExpiryOrg),
      activityUris.get(recordLabelOrg),
      activityUris.get(dateOnlyExpiryOrg),
      activityUris.get(infiniteExpiryOrg),
      activityUris.get(infiniteCtsOrg),
      activityUris.get(dateOnlyCtsOrg),
      activityUris.get(unratedOrg),
    ])
  })

  it('orders by valid JSON createdAt and safely falls back to indexed_at', async () => {
    const viewer = randomDid()
    const author = randomDid()
    await seedDidOnlyProfile(viewer)
    const indexedLaterAcrossOffsets = await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'indexed-later-across-offsets',
      {},
      '2026-07-21 10:00:00-04',
    )
    const indexedEarlierUtc = await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'indexed-earlier-utc',
      {},
      '2026-07-21 13:30:00+00',
    )
    const jsonCreatedAt = await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'json-created-at',
      { createdAt: '2026-07-21T12:00:00Z' },
      '2026-07-21 15:00:00+00',
    )
    const malformedCreatedAt = await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'malformed-created-at',
      { createdAt: '2026-02-31T11:00:00Z' },
      '2026-07-21 11:00:00+00',
    )
    const dateOnlyCreatedAt = await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'date-only-created-at',
      { createdAt: '2026-07-21' },
      '2026-07-21 10:00:00+00',
    )
    const malformedJson = await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'malformed-json',
      '{malformed-json',
      '2026-07-21 09:00:00+00',
    )
    const createdAtWithNullIndex = await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'created-at-null-index',
      { createdAt: '2026-07-21T08:30:00Z' },
      '2026-07-21 08:30:00+00',
      { indexedAt: null },
    )
    await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'null-index-without-created-at',
      {},
      '2026-07-21 08:00:00+00',
      { indexedAt: null },
    )
    await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'infinite-index',
      {},
      '2026-07-21 08:00:00+00',
      { indexedAt: 'infinity' },
    )
    await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'negative-infinite-index',
      {},
      '2026-07-21 08:00:00+00',
      { indexedAt: '-infinity' },
    )
    await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'date-only-index',
      {},
      '2026-07-21 08:00:00+00',
      { indexedAt: '2999-01-01' },
    )

    const output = await getFeedForFollows([author])

    expect(output.feed.map((item) => item.subject)).toEqual([
      indexedLaterAcrossOffsets,
      indexedEarlierUtc,
      jsonCreatedAt,
      malformedCreatedAt,
      dateOnlyCreatedAt,
      malformedJson,
      createdAtWithNullIndex,
    ])
  })

  it('pairs projects by effective timestamps, including indexed_at fallback', async () => {
    const viewer = randomDid()
    const author = randomDid()
    await seedDidOnlyProfile(viewer)

    const materializedActivity = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'materialized-pair-activity',
      { createdAt: '2026-07-21T10:00:30Z' },
      '2026-07-21T10:00:30Z',
      { indexedAt: '2026-07-21T04:00:00Z' },
    )
    const materializedCollection = await seedRecord(
      author,
      'org.hypercerts.collection',
      'materialized-pair-collection',
      {
        createdAt: '2026-07-21T10:00:00Z',
        items: [{ itemIdentifier: { uri: materializedActivity, cid } }],
      },
      '2026-07-21T10:00:00Z',
      { indexedAt: '2026-07-21T01:00:00Z' },
    )
    const fallbackActivity = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'fallback-pair-activity',
      { createdAt: { malformed: true } },
      '2026-07-21T11:00:30Z',
    )
    const fallbackCollection = await seedRecord(
      author,
      'org.hypercerts.collection',
      'fallback-pair-collection',
      {
        items: [{ itemIdentifier: { uri: fallbackActivity, cid } }],
      },
      '2026-07-21T11:00:00Z',
    )

    await seedFollow(viewer, author)
    const request = feedRequest(viewer, { limit: 50 })
    const output = await service.getFeedSkeleton(request)
    const metadata = await pages.loadPage(request, 'metadata')

    expect(output.feed.map((item) => item.subject)).toEqual([
      fallbackCollection,
      materializedCollection,
    ])
    expect(metadata.rows.map((item) => item.kind)).toEqual([
      'project.created_with_cert',
      'project.created_with_cert',
    ])
  })

  it('uses the latest subject response when deciding whether an endorsement is active', async () => {
    const viewer = randomDid()
    const evaluator = randomDid()
    const subject = randomDid()
    const offsetOrderedSubject = randomDid()
    await Promise.all([
      seedDidOnlyProfile(viewer),
      seedDidOnlyProfile(evaluator),
      seedDidOnlyProfile(subject),
      seedDidOnlyProfile(offsetOrderedSubject),
    ])

    const definitionUri = await seedRecord(
      evaluator,
      'app.certified.badge.definition',
      'latest-response-definition',
      { badgeType: 'endorsement' },
      '2026-07-21T01:00:00Z',
    )
    const awardUri = await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'latest-response-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: subject },
        createdAt: '2026-07-21T02:00:00Z',
      },
      '2026-07-21T02:00:00Z',
    )
    const subjectActivity = await seedRecord(
      subject,
      'org.hypercerts.claim.activity',
      'active-after-acceptance',
      { createdAt: '2026-07-21T03:00:00Z' },
      '2026-07-21T03:00:00Z',
    )
    await seedRecord(
      subject,
      'app.certified.badge.response',
      'older-rejection',
      {
        badgeAward: { uri: awardUri, cid },
        response: 'rejected',
        createdAt: '2026-07-21T04:00:00Z',
      },
      '2026-07-21T04:00:00Z',
      { indexedAt: '2026-07-21T06:00:00Z' },
    )
    await seedRecord(
      subject,
      'app.certified.badge.response',
      'newer-acceptance',
      {
        badgeAward: { uri: awardUri, cid },
        response: 'accepted',
        createdAt: '2026-07-21T05:00:00Z',
      },
      '2026-07-21T05:00:00Z',
      { indexedAt: '2026-07-21T03:30:00Z' },
    )

    const offsetOrderedAwardUri = await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'offset-response-order-award',
      {
        badge: { uri: definitionUri, cid },
        subject: {
          $type: 'app.certified.defs#did',
          did: offsetOrderedSubject,
        },
        createdAt: '2026-07-21T02:30:00Z',
      },
      '2026-07-21T02:30:00Z',
    )
    const offsetOrderedActivity = await seedRecord(
      offsetOrderedSubject,
      'org.hypercerts.claim.activity',
      'offset-response-order-activity',
      { createdAt: '2026-07-21T03:30:00Z' },
      '2026-07-21T03:30:00Z',
    )
    await seedRecord(
      offsetOrderedSubject,
      'app.certified.badge.response',
      'lexically-later-rejection',
      {
        badgeAward: { uri: offsetOrderedAwardUri, cid },
        response: 'rejected',
      },
      '2026-07-21 13:30:00+00',
    )
    await seedRecord(
      offsetOrderedSubject,
      'app.certified.badge.response',
      'chronologically-later-acceptance',
      {
        badgeAward: { uri: offsetOrderedAwardUri, cid },
        response: 'accepted',
      },
      '2026-07-21 10:00:00-04',
    )

    const output = await getFeedForFollows([evaluator], {
      trustedEvaluators: [evaluator],
      limit: 50,
    })

    expect(output.feed.map((item) => item.subject)).toEqual([
      offsetOrderedActivity,
      subjectActivity,
      offsetOrderedAwardUri,
      awardUri,
    ])
  })

  it('enforces allowed issuers for evaluator scope and award events', async () => {
    const viewer = randomDid()
    const disallowedIssuer = randomDid()
    const allowedIssuer = randomDid()
    const disallowedSubject = randomDid()
    await Promise.all([
      seedDidOnlyProfile(viewer),
      seedDidOnlyProfile(disallowedIssuer),
      seedDidOnlyProfile(allowedIssuer),
      seedDidOnlyProfile(disallowedSubject),
    ])

    const definitionUri = await seedRecord(
      disallowedIssuer,
      'app.certified.badge.definition',
      'restricted-definition',
      { badgeType: 'endorsement', allowedIssuers: [allowedIssuer] },
      '2026-07-21T01:00:00Z',
    )
    const disallowedAwardUri = await seedRecord(
      disallowedIssuer,
      'app.certified.badge.award',
      'disallowed-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: disallowedSubject },
      },
      '2026-07-21T02:00:00Z',
    )
    const disallowedSubjectActivity = await seedRecord(
      disallowedSubject,
      'org.hypercerts.claim.activity',
      'must-not-expand',
      { createdAt: '2026-07-21T03:00:00Z' },
      '2026-07-21T03:00:00Z',
    )

    await expect(
      service.getFeedSkeleton(
        feedRequest(viewer, { trustedEvaluators: [disallowedIssuer] }),
      ),
    ).resolves.toEqual({ feed: [] })
    await expect(getFeedForFollows([disallowedIssuer])).resolves.toEqual({
      feed: [],
    })

    const allowedAwardUri = await seedRecord(
      allowedIssuer,
      'app.certified.badge.award',
      'allowed-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: disallowedSubject },
      },
      '2026-07-21T04:00:00Z',
    )
    const malformedDefinitionUri = await seedRecord(
      allowedIssuer,
      'app.certified.badge.definition',
      'malformed-allowed-issuers-definition',
      { badgeType: 'endorsement', allowedIssuers: { did: allowedIssuer } },
      '2026-07-21T04:00:01Z',
    )
    const malformedAwardUri = await seedRecord(
      allowedIssuer,
      'app.certified.badge.award',
      'malformed-allowed-issuers-award',
      {
        badge: { uri: malformedDefinitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: disallowedSubject },
      },
      '2026-07-21T04:00:02Z',
    )
    const allowedOutput = await getFeedForFollows([allowedIssuer])

    expect(allowedOutput.feed.map((item) => item.subject)).toEqual([
      allowedAwardUri,
    ])
    expect(
      allowedOutput.feed.some((item) => item.subject === disallowedAwardUri),
    ).toBe(false)
    expect(
      allowedOutput.feed.some((item) => item.subject === malformedAwardUri),
    ).toBe(false)
    expect(
      allowedOutput.feed.some(
        (item) => item.subject === disallowedSubjectActivity,
      ),
    ).toBe(false)
  })

  it('does not turn record-target endorsements into account endorsements', async () => {
    const viewer = randomDid()
    const evaluator = randomDid()
    const recordOwner = randomDid()
    await Promise.all([
      seedDidOnlyProfile(viewer),
      seedDidOnlyProfile(evaluator),
      seedDidOnlyProfile(recordOwner),
    ])

    const targetActivity = await seedRecord(
      recordOwner,
      'org.hypercerts.claim.activity',
      'record-target',
      { createdAt: '2026-07-21T03:00:00Z' },
      '2026-07-21T03:00:00Z',
    )
    const definitionUri = await seedRecord(
      evaluator,
      'app.certified.badge.definition',
      'record-target-definition',
      { badgeType: 'endorsement' },
      '2026-07-21T01:00:00Z',
    )
    await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'record-target-award',
      {
        badge: { uri: definitionUri, cid },
        subject: {
          $type: 'com.atproto.repo.strongRef',
          uri: targetActivity,
          cid,
        },
        createdAt: '2026-07-21T02:00:00Z',
      },
      '2026-07-21T02:00:00Z',
    )
    await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'wrong-subject-type-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'example.invalid#did', did: recordOwner },
        createdAt: '2026-07-21T02:30:00Z',
      },
      '2026-07-21T02:30:00Z',
    )

    await expect(
      service.getFeedSkeleton(
        feedRequest(viewer, { trustedEvaluators: [evaluator] }),
      ),
    ).resolves.toEqual({ feed: [] })

    await expect(getFeedForFollows([evaluator])).resolves.toEqual({ feed: [] })
  })

  it('requires exact CIDs when pairing projects and resolving badge definitions', async () => {
    const viewer = randomDid()
    const author = randomDid()
    const endorsementSubject = randomDid()
    await Promise.all([
      seedDidOnlyProfile(viewer),
      seedDidOnlyProfile(author),
      seedDidOnlyProfile(endorsementSubject),
    ])

    const activityUri = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'current-activity-version',
      { createdAt: '2026-07-21T10:00:00Z' },
      '2026-07-21T10:00:00Z',
    )
    const collectionUri = await seedRecord(
      author,
      'org.hypercerts.collection',
      'stale-activity-reference',
      {
        createdAt: '2026-07-21T10:00:10Z',
        items: [{ itemIdentifier: { uri: activityUri, cid: staleCid } }],
      },
      '2026-07-21T10:00:10Z',
    )
    const definitionUri = await seedRecord(
      author,
      'app.certified.badge.definition',
      'current-definition-version',
      { badgeType: 'endorsement' },
      '2026-07-21T09:00:00Z',
    )
    const awardUri = await seedRecord(
      author,
      'app.certified.badge.award',
      'stale-definition-reference',
      {
        badge: { uri: definitionUri, cid: staleCid },
        subject: {
          $type: 'app.certified.defs#did',
          did: endorsementSubject,
        },
        createdAt: '2026-07-21T09:30:00Z',
      },
      '2026-07-21T09:30:00Z',
    )
    const subjectActivity = await seedRecord(
      endorsementSubject,
      'org.hypercerts.claim.activity',
      'must-not-enter-through-stale-definition',
      { createdAt: '2026-07-21T11:00:00Z' },
      '2026-07-21T11:00:00Z',
    )

    await seedFollow(viewer, author)
    const request = feedRequest(viewer, {
      trustedEvaluators: [author],
      limit: 50,
    })
    const output = await service.getFeedSkeleton(request)
    const metadata = await pages.loadPage(request, 'metadata')

    expect(output.feed.map((item) => item.subject)).toEqual([
      collectionUri,
      activityUri,
    ])
    expect(metadata.rows.map((item) => item.kind)).toEqual([
      'collection.create',
      'cert.create',
    ])
    expect(output.feed.some((item) => item.subject === awardUri)).toBe(false)
    expect(output.feed.some((item) => item.subject === subjectActivity)).toBe(
      false,
    )
  })

  it('suppresses a paired activity across a pagination boundary', async () => {
    const viewer = randomDid()
    const author = randomDid()
    await Promise.all([seedDidOnlyProfile(viewer), seedDidOnlyProfile(author)])

    const pairedActivity = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'paired',
      { createdAt: '2026-07-21T10:00:02Z' },
      '2026-07-21T10:00:02Z',
    )
    const collection = await seedRecord(
      author,
      'org.hypercerts.collection',
      'project',
      {
        createdAt: '2026-07-21T10:00:04Z',
        items: [{ itemIdentifier: { uri: pairedActivity, cid } }],
      },
      '2026-07-21T10:00:04Z',
    )
    const standalone = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'standalone',
      { createdAt: '2026-07-21T10:00:03Z' },
      '2026-07-21T10:00:03Z',
    )
    const old = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'old',
      { createdAt: '2026-07-21T09:00:00Z' },
      '2026-07-21T09:00:00Z',
    )

    await seedFollow(viewer, author)
    const request = feedRequest(viewer, { limit: 2 })
    const first = await service.getFeedSkeleton(request)
    const metadata = await pages.loadPage(request, 'metadata')
    expect(first.feed.map((item) => item.subject)).toEqual([
      collection,
      standalone,
    ])
    expect(metadata.rows[0]?.kind).toBe('project.created_with_cert')

    if (first.cursor === undefined)
      throw new Error('expected a next-page cursor')
    const second = await service.getFeedSkeleton(
      feedRequest(viewer, { limit: 2, cursor: first.cursor }),
    )
    expect(second.feed.map((item) => item.subject)).toEqual([old])
  })

  it('paginates equal timestamps by descending URI without repeats', async () => {
    const viewer = randomDid()
    const author = randomDid()
    await Promise.all([seedDidOnlyProfile(viewer), seedDidOnlyProfile(author)])

    const uris: string[] = []
    for (const rkey of ['a', 'b', 'c']) {
      uris.push(
        await seedRecord(
          author,
          'org.hypercerts.context.measurement',
          rkey,
          { createdAt: '2026-07-21T12:00:00Z' },
          '2026-07-21T12:00:00Z',
        ),
      )
    }

    await seedFollow(viewer, author)
    const first = await service.getFeedSkeleton(
      feedRequest(viewer, { limit: 2 }),
    )
    expect(first.feed.map((item) => item.subject)).toEqual([uris[2], uris[1]])
    expect(first.cursor).toBeDefined()

    if (first.cursor === undefined) {
      throw new Error('expected a next-page cursor')
    }
    const second = await service.getFeedSkeleton(
      feedRequest(viewer, { limit: 2, cursor: first.cursor }),
    )
    expect(second.feed.map((item) => item.subject)).toEqual([uris[0]])
    expect(second.cursor).toBeUndefined()
  })

  it('ignores malformed follow subjects before they can enter the feed', async () => {
    const viewer = randomDid()
    const malformedDid = `invalid-${randomBytes(8).toString('hex')}`
    await seedDidOnlyProfile(viewer)
    await seedRecord(
      viewer,
      'app.certified.graph.follow',
      'malformed-follow',
      { subject: malformedDid },
      '2026-07-22T01:00:00Z',
    )
    await seedRecord(
      malformedDid,
      'org.hypercerts.claim.activity',
      'must-not-break-feed',
      { createdAt: '2026-07-22T02:00:00Z' },
      '2026-07-22T02:00:00Z',
    )

    await expect(service.getFeedSkeleton(feedRequest(viewer))).resolves.toEqual(
      { feed: [] },
    )
  })

  it('ignores responses that target a stale award CID', async () => {
    const viewer = randomDid()
    const evaluator = randomDid()
    const subject = randomDid()
    await Promise.all([
      seedDidOnlyProfile(viewer),
      seedDidOnlyProfile(evaluator),
      seedDidOnlyProfile(subject),
    ])

    const definitionUri = await seedRecord(
      evaluator,
      'app.certified.badge.definition',
      'stale-response-definition',
      { badgeType: 'endorsement' },
      '2026-07-22T03:00:00Z',
    )
    const awardUri = await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'stale-response-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: subject },
      },
      '2026-07-22T04:00:00Z',
    )
    const subjectActivity = await seedRecord(
      subject,
      'org.hypercerts.claim.activity',
      'stale-response-subject',
      { createdAt: '2026-07-22T05:00:00Z' },
      '2026-07-22T05:00:00Z',
    )
    await seedRecord(
      subject,
      'app.certified.badge.response',
      'stale-response-rejection',
      {
        badgeAward: { uri: awardUri, cid: staleCid },
        response: 'rejected',
      },
      '2026-07-22T06:00:00Z',
    )

    const authorOutput = await getFeedForFollows([evaluator])
    expect(authorOutput.feed).toEqual([{ subject: awardUri }])

    const evaluatorOutput = await service.getFeedSkeleton(
      feedRequest(viewer, { trustedEvaluators: [evaluator] }),
    )
    expect(evaluatorOutput.feed).toEqual([{ subject: subjectActivity }])
  })

  it('always derives the base scope from the viewer current follows', async () => {
    const viewer = randomDid()
    const followedAuthor = randomDid()
    const unfollowedAuthor = randomDid()
    await seedDidOnlyProfile(viewer)
    const followedUri = await seedRecord(
      followedAuthor,
      'org.hypercerts.claim.activity',
      'followed-author',
      { createdAt: '2026-07-22T07:00:00Z' },
      '2026-07-22T07:00:00Z',
    )
    const unfollowedUri = await seedRecord(
      unfollowedAuthor,
      'org.hypercerts.claim.activity',
      'unfollowed-author',
      { createdAt: '2026-07-22T08:00:00Z' },
      '2026-07-22T08:00:00Z',
    )
    await seedFollow(viewer, followedAuthor)

    const output = await service.getFeedSkeleton(feedRequest(viewer))

    expect(output.feed.map((item) => item.subject)).toEqual([followedUri])
    expect(output.feed.some((item) => item.subject === unfollowedUri)).toBe(
      false,
    )
  })

  it('supports more than 500 followed accounts without truncating the scope', async () => {
    const viewer = randomDid()
    const followedDids = Array.from({ length: 501 }, randomDid)
    const selectedAuthor = followedDids.at(-1)
    if (selectedAuthor === undefined) {
      throw new Error('Expected a followed-author fixture')
    }
    await seedDidOnlyProfile(viewer)
    await getAdmin().query(
      `INSERT INTO happyview_records (
         uri, did, collection, rkey, record, cid, indexed_at, created_at
       )
       SELECT
         'at://' || $1::text || '/app.certified.graph.follow/scope-' ||
           followed.ordinality::text,
         $1::text,
         'app.certified.graph.follow',
         'scope-' || followed.ordinality::text,
         jsonb_build_object('subject', followed.did)::text,
         $2::text,
         ('2026-07-22T10:00:00Z'::timestamptz +
           followed.ordinality * INTERVAL '1 millisecond')::text,
         '2026-07-20 00:00:00+00'
       FROM unnest($3::text[]) WITH ORDINALITY AS followed(did, ordinality)`,
      [viewer, cid, followedDids],
    )
    const selectedUri = await seedRecord(
      selectedAuthor,
      'org.hypercerts.claim.activity',
      'large-follow-scope',
      { createdAt: '2026-07-22T11:00:00Z' },
      '2026-07-22T11:00:00Z',
    )

    const output = await service.getFeedSkeleton(feedRequest(viewer))

    expect(output.feed.map((item) => item.subject)).toEqual([selectedUri])
  })
})
