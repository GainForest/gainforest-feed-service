import type { QueryResultRow } from 'pg'

import type { ActorContext, IdentityReader } from './types.js'

const IDENTITY_QUERY = `
  WITH requested(did) AS (
    SELECT DISTINCT did
    FROM unnest($1::text[]) AS input(did)
  )
  SELECT
    requested.did AS requested_did,
    certified_profile.record AS certified_profile_json
  FROM requested
  LEFT JOIN happyview_records AS certified_profile
    ON certified_profile.uri = 'at://' || requested.did || '/app.certified.actor.profile/self'
   AND certified_profile.collection = 'app.certified.actor.profile'
   AND certified_profile.did = requested.did
`

interface IdentityQueryRow extends QueryResultRow {
  requested_did: string
  certified_profile_json: unknown
}

const parseCertifiedProfile = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') return value
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed === null ? undefined : parsed
  } catch {
    return undefined
  }
}

/** Narrow structural query capability used by the identity adapter. */
export interface IdentityQueryExecutor {
  query<T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>
}

/** Read-only PostgreSQL adapter for current HappyView Certified-profile data. */
export class PostgresIdentityReader implements IdentityReader {
  constructor(private readonly database: IdentityQueryExecutor) {}

  async getByDids(
    dids: readonly string[],
  ): Promise<ReadonlyMap<string, ActorContext>> {
    const uniqueDids = [...new Set(dids)]
    if (uniqueDids.length === 0) return new Map()

    const contexts = new Map<string, ActorContext>(
      uniqueDids.map((did) => [did, { did }]),
    )
    const result = await this.database.query<IdentityQueryRow>(IDENTITY_QUERY, [
      uniqueDids,
    ])
    const seenDids = new Set<string>()

    for (const row of result.rows) {
      if (!contexts.has(row.requested_did)) {
        throw new Error(
          'Identity query returned an unrequested DID; verify the requested-DID projection and bind order before serving hydrated pages.',
        )
      }
      if (seenDids.has(row.requested_did)) {
        throw new Error(
          'Identity query returned duplicate result rows for the same requested DID; verify the identity joins preserve one row per DID before serving hydrated pages.',
        )
      }
      seenDids.add(row.requested_did)
      const certifiedProfile = parseCertifiedProfile(row.certified_profile_json)
      contexts.set(row.requested_did, {
        did: row.requested_did,
        ...(certifiedProfile === undefined ? {} : { certifiedProfile }),
      })
    }

    return contexts
  }
}
