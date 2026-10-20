import type {
  FeedPageLoader,
  InternalSourceFeedRow,
} from '../feed/registry.js'
import type { GetFeedSkeletonInput } from '../feed/types.js'
import type {
  ActorContext,
  ActorSummary,
  GetHydratedFeedOutput,
  HydratedFeedItem,
  IdentityReader,
} from './types.js'
import {
  getEndorsedActorDid,
  validateCertifiedProfile,
  validateFeedRecord,
  type ValidatedFeedRecord,
} from './validation.js'
import { buildActorSummary, buildFeedItemView } from './views.js'

const identityInvariantError = (): Error =>
  new Error(
    'Hydrated feed identity invariant failed: the identity batch omitted or mismatched a context for a requested DID; verify IdentityReader returns one exact context per requested DID before serving hydrated pages.',
  )

const requireActorSummary = (
  did: string,
  contexts: ReadonlyMap<string, ActorContext>,
): ActorSummary => {
  const context = contexts.get(did)
  if (context?.did !== did) {
    throw identityInvariantError()
  }

  return buildActorSummary(
    did,
    validateCertifiedProfile(context.certifiedProfile),
  )
}

interface ValidatedFeedRow {
  readonly row: InternalSourceFeedRow
  readonly record: ValidatedFeedRecord
  readonly endorsedDid: string | undefined
}

interface ValidatedFeedBatch {
  readonly rows: readonly ValidatedFeedRow[]
  readonly requestedDids: ReadonlySet<string>
}

const collectValidatedFeedRows = (
  rows: readonly InternalSourceFeedRow[],
): ValidatedFeedBatch => {
  const validatedRows: ValidatedFeedRow[] = []
  const requestedDids = new Set<string>()

  for (const row of rows) {
    const record = validateFeedRecord(
      row.kind,
      row.collection,
      row.sourceValue,
    )
    if (record === undefined) continue

    const endorsedDid = getEndorsedActorDid(record)
    validatedRows.push({ row, record, endorsedDid })
    requestedDids.add(row.actorDid)
    if (endorsedDid !== undefined) requestedDids.add(endorsedDid)
  }

  return { rows: validatedRows, requestedDids }
}

const buildHydratedFeedItems = (
  validatedRows: readonly ValidatedFeedRow[],
  summaries: ReadonlyMap<string, ActorSummary>,
): HydratedFeedItem[] =>
  validatedRows.map(({ row, record, endorsedDid }) => {
    const actor = summaries.get(row.actorDid)
    if (actor === undefined || actor.did !== row.actorDid) {
      throw identityInvariantError()
    }
    const endorsedActor =
      endorsedDid === undefined ? undefined : summaries.get(endorsedDid)

    return {
      subject: row.uri,
      view: {
        $type: 'org.hypercerts.feed.defs#hypercertsFeedView',
        kind: row.kind,
        actor,
        content: buildFeedItemView(record, {
          ...(endorsedActor === undefined ? {} : { endorsedActor }),
        }),
      },
    }
  })

const buildOutput = (
  feed: readonly HydratedFeedItem[],
  cursor: string | undefined,
): GetHydratedFeedOutput => ({
  feed,
  ...(cursor === undefined ? {} : { cursor }),
})

/** Application seam consumed by the hydrated XRPC transport. */
export interface HydratedFeedReader {
  getFeed(input: GetFeedSkeletonInput): Promise<GetHydratedFeedOutput>
}

/** Coordinates one same-statement source page and one bounded identity batch. */
export class HydratedFeedService implements HydratedFeedReader {
  constructor(
    private readonly pages: FeedPageLoader,
    private readonly identities: IdentityReader,
  ) {}

  /** Builds one ordered, view-only hydrated feed page. */
  async getFeed(
    input: GetFeedSkeletonInput,
  ): Promise<GetHydratedFeedOutput> {
    const page = await this.pages.loadPage(input, 'with-source')
    const batch = collectValidatedFeedRows(page.rows)

    if (batch.rows.length === 0) {
      return buildOutput([], page.cursor)
    }

    const summaries = await this.loadActorSummaries(batch.requestedDids)
    return buildOutput(
      buildHydratedFeedItems(batch.rows, summaries),
      page.cursor,
    )
  }

  private async loadActorSummaries(
    requestedDids: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, ActorSummary>> {
    const contexts = await this.identities.getByDids([...requestedDids])
    const summaries = new Map<string, ActorSummary>()

    for (const did of requestedDids) {
      summaries.set(did, requireActorSummary(did, contexts))
    }

    return summaries
  }
}
