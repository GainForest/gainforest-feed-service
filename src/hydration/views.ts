import type {
  ActivityFeedView,
  ActorImageReference,
  ActorSummary,
  CollectionFeedView,
  CollectionImageReference,
  EndorsementFeedView,
  EvaluationFeedView,
  FeedItemView,
  FeedTargetReference,
  LargeImageReference,
  MeasurementFeedView,
  SmallBlobImageReference,
  UpdateFeedView,
  UriImageReference,
} from './types.js'
import {
  getEndorsedActorDid,
  isMeaningfulCertifiedProfile,
  toProtocolBlobRef,
  type ValidatedCertifiedProfile,
  type ValidatedFeedRecord,
} from './validation.js'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const uriImageReference = (value: unknown): UriImageReference | undefined =>
  isObject(value) &&
  value.$type === 'org.hypercerts.defs#uri' &&
  typeof value.uri === 'string'
    ? { $type: 'org.hypercerts.defs#uri', uri: value.uri }
    : undefined

const smallImageReference = (
  value: unknown,
): ActorImageReference | undefined => {
  const uri = uriImageReference(value)
  if (uri !== undefined) return uri
  if (!isObject(value) || value.$type !== 'org.hypercerts.defs#smallImage') {
    return undefined
  }
  const image = toProtocolBlobRef(value.image)
  return image === undefined
    ? undefined
    : { $type: 'org.hypercerts.defs#smallImage', image }
}

const largeImageReference = (
  value: unknown,
): UriImageReference | LargeImageReference | undefined => {
  const uri = uriImageReference(value)
  if (uri !== undefined) return uri
  if (!isObject(value) || value.$type !== 'org.hypercerts.defs#largeImage') {
    return undefined
  }
  const image = toProtocolBlobRef(value.image)
  return image === undefined
    ? undefined
    : { $type: 'org.hypercerts.defs#largeImage', image }
}

const smallBlobImageReference = (
  value: unknown,
): SmallBlobImageReference | undefined => {
  if (!isObject(value) || value.$type !== 'org.hypercerts.defs#smallBlob') {
    return undefined
  }
  const blob = toProtocolBlobRef(value.blob)
  return blob === undefined
    ? undefined
    : { $type: 'org.hypercerts.defs#smallBlob', blob }
}

/** Uses a meaningful Certified profile, otherwise returns a DID-only identity. */
export const buildActorSummary = (
  did: string,
  certifiedProfile: ValidatedCertifiedProfile | undefined,
): ActorSummary => {
  if (
    certifiedProfile &&
    isMeaningfulCertifiedProfile(certifiedProfile)
  ) {
    const avatar = smallImageReference(certifiedProfile.avatar)
    return {
      did,
      ...(certifiedProfile.displayName === undefined
        ? {}
        : { displayName: certifiedProfile.displayName }),
      ...(avatar === undefined ? {} : { avatar }),
    }
  }

  return { did }
}

export interface FeedViewContext {
  readonly endorsedActor?: ActorSummary
}

const targetReference = (
  target: { readonly uri: string; readonly cid: string } | undefined,
): FeedTargetReference | undefined =>
  target === undefined ? undefined : { uri: target.uri, cid: target.cid }

const endorsementViewInvariantError = (): Error =>
  new Error(
    'Endorsement view failed because the endorsed account could not be matched to its discovered identity; verify endorsement DID discovery and identity mapping before serving hydrated pages.',
  )

type FeedRecordValue<
  Collection extends ValidatedFeedRecord['collection'],
> = Extract<
  ValidatedFeedRecord,
  { readonly collection: Collection }
>['value']

type EndorsementRecord = Extract<
  ValidatedFeedRecord,
  { readonly collection: 'app.certified.badge.award' }
>

const buildActivityView = (
  value: FeedRecordValue<'org.hypercerts.claim.activity'>,
): ActivityFeedView => {
  const image = smallImageReference(value.image)
  return {
    $type: 'org.hypercerts.feed.defs#activityView',
    title: value.title,
    shortDescription: value.shortDescription,
    ...(image === undefined ? {} : { image }),
    createdAt: value.createdAt,
    ...(value.startDate === undefined ? {} : { startDate: value.startDate }),
    ...(value.endDate === undefined ? {} : { endDate: value.endDate }),
    locationCount: value.locations?.length ?? 0,
  }
}

const buildCollectionView = (
  value: FeedRecordValue<'org.hypercerts.collection'>,
): CollectionFeedView => {
  const image: CollectionImageReference | undefined =
    smallImageReference(value.avatar) ?? largeImageReference(value.banner)
  return {
    $type: 'org.hypercerts.feed.defs#collectionView',
    ...(value.type === undefined ? {} : { collectionType: value.type }),
    title: value.title,
    ...(value.shortDescription === undefined
      ? {}
      : { shortDescription: value.shortDescription }),
    ...(image === undefined ? {} : { image }),
    createdAt: value.createdAt,
    itemCount: value.items?.length ?? 0,
  }
}

const buildEndorsementView = (
  record: EndorsementRecord,
  context: FeedViewContext,
): EndorsementFeedView => {
  const subjectDid = getEndorsedActorDid(record)
  if (
    subjectDid === undefined ||
    context.endorsedActor === undefined ||
    context.endorsedActor.did !== subjectDid
  ) {
    throw endorsementViewInvariantError()
  }
  return {
    $type: 'org.hypercerts.feed.defs#endorsementView',
    subject: context.endorsedActor,
    createdAt: record.value.createdAt,
  }
}

const buildEvaluationView = (
  value: FeedRecordValue<'org.hypercerts.context.evaluation'>,
): EvaluationFeedView => {
  const target = targetReference(value.subject)
  return {
    $type: 'org.hypercerts.feed.defs#evaluationView',
    summary: value.summary,
    createdAt: value.createdAt,
    ...(target === undefined ? {} : { target }),
  }
}

const buildMeasurementView = (
  value: FeedRecordValue<'org.hypercerts.context.measurement'>,
): MeasurementFeedView => {
  const target = targetReference(value.subjects?.[0])
  return {
    $type: 'org.hypercerts.feed.defs#measurementView',
    metric: value.metric,
    createdAt: value.createdAt,
    ...(target === undefined ? {} : { target }),
  }
}

const buildUpdateView = (
  value: FeedRecordValue<'org.hypercerts.context.attachment'>,
): UpdateFeedView => {
  const imageBlob = value.content?.find(
    (entry) =>
      isObject(entry) &&
      entry.$type === 'org.hypercerts.defs#smallBlob' &&
      isObject(entry.blob) &&
      typeof entry.blob.mimeType === 'string' &&
      entry.blob.mimeType.startsWith('image/'),
  )
  const image = smallBlobImageReference(imageBlob)
  const target = targetReference(value.subjects?.[0])
  return {
    $type: 'org.hypercerts.feed.defs#updateView',
    title: value.title,
    ...(value.shortDescription === undefined
      ? {}
      : { shortDescription: value.shortDescription }),
    ...(image === undefined ? {} : { image }),
    createdAt: value.createdAt,
    ...(target === undefined ? {} : { target }),
  }
}

/** Builds one stable feed-card view without performing hydration or other I/O. */
export const buildFeedItemView = (
  record: ValidatedFeedRecord,
  context: FeedViewContext = {},
): FeedItemView => {
  switch (record.kind) {
    case 'cert.create':
      return buildActivityView(record.value)
    case 'collection.create':
    case 'project.created_with_cert':
      return buildCollectionView(record.value)
    case 'endorsement.award':
      return buildEndorsementView(record, context)
    case 'evaluation.create':
      return buildEvaluationView(record.value)
    case 'measurement.create':
      return buildMeasurementView(record.value)
    case 'update.create':
      return buildUpdateView(record.value)
  }
}
