import { isBlobRef, lexParse, type BlobRef } from '@atproto/lex'
import { jsonToLex as jsonToLegacyLex } from '@atproto/lexicon'
import {
  AppCertifiedActorProfile,
  AppCertifiedBadgeAward,
  OrgHypercertsClaimActivity,
  OrgHypercertsCollection,
  OrgHypercertsContextAttachment,
  OrgHypercertsContextEvaluation,
  OrgHypercertsContextMeasurement,
} from '@hypercerts-org/lexicon'

import type { FeedKind } from '../feed/types.js'

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
])
const SMALL_IMAGE_MAX_BYTES = 5_242_880
const LARGE_IMAGE_MAX_BYTES = 10_485_760
const SMALL_BLOB_MAX_BYTES = 10_485_760

/** Certified profile shape accepted by the authoritative v1.0.0 validator. */
export type ValidatedCertifiedProfile = AppCertifiedActorProfile.Record

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Bridges validated legacy BlobRef values into the protocol representation used by generated feed schemas. */
export const toProtocolBlobRef = (blob: unknown): BlobRef | undefined => {
  try {
    if (isBlobRef(blob)) return blob
    const parsed = lexParse(JSON.stringify(blob), { strict: true })
    return isBlobRef(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const hasValidBlobRef = (
  blob: unknown,
  maxSize: number,
  allowedMimeTypes?: ReadonlySet<string>,
): boolean =>
  isObject(blob) &&
  typeof blob.mimeType === 'string' &&
  (allowedMimeTypes === undefined || allowedMimeTypes.has(blob.mimeType)) &&
  typeof blob.size === 'number' &&
  Number.isInteger(blob.size) &&
  blob.size >= 0 &&
  blob.size <= maxSize &&
  toProtocolBlobRef(blob) !== undefined

const hasValidKnownBlob = (
  value: unknown,
  type: 'org.hypercerts.defs#smallImage' | 'org.hypercerts.defs#largeImage',
  maxSize: number,
): boolean => {
  if (!isObject(value) || value.$type !== type) return true
  return hasValidBlobRef(value.image, maxSize, ALLOWED_IMAGE_MIME_TYPES)
}

const hasValidKnownSmallBlob = (value: unknown): boolean => {
  if (!isObject(value) || value.$type !== 'org.hypercerts.defs#smallBlob') {
    return true
  }
  return hasValidBlobRef(value.blob, SMALL_BLOB_MAX_BYTES)
}

const hasValidKnownProfileBlobs = (
  profile: ValidatedCertifiedProfile,
): boolean =>
  hasValidKnownBlob(
    profile.avatar,
    'org.hypercerts.defs#smallImage',
    SMALL_IMAGE_MAX_BYTES,
  ) &&
  hasValidKnownBlob(
    profile.banner,
    'org.hypercerts.defs#largeImage',
    LARGE_IMAGE_MAX_BYTES,
  )

/** Validates an indexed Certified profile before any field reaches a public summary. */
export const validateCertifiedProfile = (
  value: unknown,
): ValidatedCertifiedProfile | undefined => {
  try {
    // The generated validator requires its own BlobRef class, so the parser and
    // @hypercerts-org/lexicon must resolve the same @atproto/lexicon version.
    const indexedJson = value
    const result = AppCertifiedActorProfile.validateRecord(
      jsonToLegacyLex(indexedJson),
    )
    if (!result.success || !hasValidKnownProfileBlobs(result.value)) {
      return undefined
    }
    return result.value
  } catch {
    return undefined
  }
}

/** Whether a validated Certified profile contains any user-authored profile content. */
export const isMeaningfulCertifiedProfile = (
  profile: ValidatedCertifiedProfile,
): boolean =>
  (profile.displayName !== undefined && profile.displayName !== '') ||
  (profile.description !== undefined && profile.description !== '') ||
  profile.avatar !== undefined ||
  profile.banner !== undefined ||
  (profile.pronouns !== undefined && profile.pronouns !== '') ||
  (profile.website !== undefined && profile.website !== '')

export type ValidatedFeedRecord =
  | {
      readonly kind: 'cert.create'
      readonly collection: 'org.hypercerts.claim.activity'
      readonly rawValue: unknown
      readonly value: OrgHypercertsClaimActivity.Record
    }
  | {
      readonly kind: 'collection.create' | 'project.created_with_cert'
      readonly collection: 'org.hypercerts.collection'
      readonly rawValue: unknown
      readonly value: OrgHypercertsCollection.Record
    }
  | {
      readonly kind: 'evaluation.create'
      readonly collection: 'org.hypercerts.context.evaluation'
      readonly rawValue: unknown
      readonly value: OrgHypercertsContextEvaluation.Record
    }
  | {
      readonly kind: 'measurement.create'
      readonly collection: 'org.hypercerts.context.measurement'
      readonly rawValue: unknown
      readonly value: OrgHypercertsContextMeasurement.Record
    }
  | {
      readonly kind: 'update.create'
      readonly collection: 'org.hypercerts.context.attachment'
      readonly rawValue: unknown
      readonly value: OrgHypercertsContextAttachment.Record
    }
  | {
      readonly kind: 'endorsement.award'
      readonly collection: 'app.certified.badge.award'
      readonly rawValue: unknown
      readonly value: AppCertifiedBadgeAward.Record
    }

const hasRecordType = (value: unknown, type: string): boolean =>
  isObject(value) && value.$type === type

const hasAccountSubject = (value: AppCertifiedBadgeAward.Record): boolean =>
  isObject(value.subject) &&
  value.subject.$type === 'app.certified.defs#did' &&
  typeof value.subject.did === 'string'

type ValidatedFeedRecordFor<
  Collection extends ValidatedFeedRecord['collection'],
> = Extract<ValidatedFeedRecord, { readonly collection: Collection }>

const validateActivityRecord = (
  kind: FeedKind,
  rawValue: unknown,
  parsedValue: unknown,
): ValidatedFeedRecordFor<'org.hypercerts.claim.activity'> | undefined => {
  if (kind !== 'cert.create') return undefined

  const result = OrgHypercertsClaimActivity.validateRecord(parsedValue)
  if (
    !result.success ||
    !hasValidKnownBlob(
      result.value.image,
      'org.hypercerts.defs#smallImage',
      SMALL_IMAGE_MAX_BYTES,
    )
  ) {
    return undefined
  }
  return {
    kind,
    collection: 'org.hypercerts.claim.activity',
    rawValue,
    value: result.value,
  }
}

const validateCollectionRecord = (
  kind: FeedKind,
  rawValue: unknown,
  parsedValue: unknown,
): ValidatedFeedRecordFor<'org.hypercerts.collection'> | undefined => {
  if (kind !== 'collection.create' && kind !== 'project.created_with_cert') {
    return undefined
  }

  const result = OrgHypercertsCollection.validateRecord(parsedValue)
  if (
    !result.success ||
    !hasValidKnownBlob(
      result.value.avatar,
      'org.hypercerts.defs#smallImage',
      SMALL_IMAGE_MAX_BYTES,
    ) ||
    !hasValidKnownBlob(
      result.value.banner,
      'org.hypercerts.defs#largeImage',
      LARGE_IMAGE_MAX_BYTES,
    )
  ) {
    return undefined
  }
  return {
    kind,
    collection: 'org.hypercerts.collection',
    rawValue,
    value: result.value,
  }
}

const validateEvaluationRecord = (
  kind: FeedKind,
  rawValue: unknown,
  parsedValue: unknown,
): ValidatedFeedRecordFor<'org.hypercerts.context.evaluation'> | undefined => {
  if (kind !== 'evaluation.create') return undefined

  const result = OrgHypercertsContextEvaluation.validateRecord(parsedValue)
  if (
    !result.success ||
    (result.value.content !== undefined &&
      !result.value.content.every(hasValidKnownSmallBlob))
  ) {
    return undefined
  }
  return {
    kind,
    collection: 'org.hypercerts.context.evaluation',
    rawValue,
    value: result.value,
  }
}

const validateMeasurementRecord = (
  kind: FeedKind,
  rawValue: unknown,
  parsedValue: unknown,
): ValidatedFeedRecordFor<'org.hypercerts.context.measurement'> | undefined => {
  if (kind !== 'measurement.create') return undefined

  const result = OrgHypercertsContextMeasurement.validateRecord(parsedValue)
  if (!result.success) return undefined
  return {
    kind,
    collection: 'org.hypercerts.context.measurement',
    rawValue,
    value: result.value,
  }
}

const validateUpdateRecord = (
  kind: FeedKind,
  rawValue: unknown,
  parsedValue: unknown,
): ValidatedFeedRecordFor<'org.hypercerts.context.attachment'> | undefined => {
  if (kind !== 'update.create') return undefined

  const result = OrgHypercertsContextAttachment.validateRecord(parsedValue)
  if (
    !result.success ||
    (result.value.content !== undefined &&
      !result.value.content.every(hasValidKnownSmallBlob))
  ) {
    return undefined
  }
  return {
    kind,
    collection: 'org.hypercerts.context.attachment',
    rawValue,
    value: result.value,
  }
}

const validateEndorsementRecord = (
  kind: FeedKind,
  rawValue: unknown,
  parsedValue: unknown,
): ValidatedFeedRecordFor<'app.certified.badge.award'> | undefined => {
  if (kind !== 'endorsement.award') return undefined

  const result = AppCertifiedBadgeAward.validateRecord(parsedValue)
  if (!result.success || !hasAccountSubject(result.value)) return undefined
  return {
    kind,
    collection: 'app.certified.badge.award',
    rawValue,
    value: result.value,
  }
}

/** Validates one raw indexed record using only its trusted collection and skeleton kind. */
export const validateFeedRecord = (
  kind: FeedKind,
  collection: string,
  value: unknown,
): ValidatedFeedRecord | undefined => {
  if (!hasRecordType(value, collection)) return undefined

  try {
    const parsedValue = jsonToLegacyLex(value)
    switch (collection) {
      case 'org.hypercerts.claim.activity':
        return validateActivityRecord(kind, value, parsedValue)
      case 'org.hypercerts.collection':
        return validateCollectionRecord(kind, value, parsedValue)
      case 'org.hypercerts.context.evaluation':
        return validateEvaluationRecord(kind, value, parsedValue)
      case 'org.hypercerts.context.measurement':
        return validateMeasurementRecord(kind, value, parsedValue)
      case 'org.hypercerts.context.attachment':
        return validateUpdateRecord(kind, value, parsedValue)
      case 'app.certified.badge.award':
        return validateEndorsementRecord(kind, value, parsedValue)
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

/** Returns the account subject for a validated endorsement award. */
export const getEndorsedActorDid = (
  record: ValidatedFeedRecord,
): string | undefined => {
  if (record.kind !== 'endorsement.award') return undefined
  return isObject(record.value.subject) &&
    record.value.subject.$type === 'app.certified.defs#did' &&
    typeof record.value.subject.did === 'string'
    ? record.value.subject.did
    : undefined
}
