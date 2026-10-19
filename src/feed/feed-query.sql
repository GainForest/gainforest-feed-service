WITH
timestamp_patterns AS NOT MATERIALIZED (
  SELECT
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'::text AS rfc3339_timestamp_pattern,
    '-00:00$'::text AS rfc3339_unknown_offset_suffix_pattern,
    '^[0-9]{4}-[0-9]{2}-[0-9]{2} ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?[+-]([01][0-9]|2[0-3])(:[0-5][0-9](:[0-5][0-9])?)?$'::text AS postgres_timestamp_pattern,
    '-00(:00(:00)?)?$'::text AS postgres_unknown_offset_suffix_pattern
),
-- =============================================================================
-- Scope resolution
-- Combine the viewer's current Certified follows with valid DID endorsements
-- from trusted evaluators, then apply HappyView's current label projection.
-- =============================================================================
base_authors AS (
  SELECT follow_json.value->>'subject' AS did
  FROM happyview_records AS follow
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN pg_input_is_valid(follow.record, 'jsonb')
        THEN follow.record::jsonb
      ELSE NULL::jsonb
    END AS value
  ) AS follow_json
  WHERE follow.collection = 'app.certified.graph.follow'
    AND follow.did = $1
    AND jsonb_typeof(follow_json.value->'subject') = 'string'
    -- Bound untrusted values and require the conservative DID shape accepted by
    -- this service before allowing them to expand the feed scope.
    AND char_length(follow_json.value->>'subject') <= 2048
    AND follow_json.value->>'subject' ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$'
),
-- This rule is shared by evaluator scope expansion and visible award events.
-- NOT MATERIALIZED lets PostgreSQL push each consumer's DID/URI filters into it.
valid_endorsement_awards AS NOT MATERIALIZED (
  SELECT
    award.*,
    award_json.value AS record_json,
    award_json.value->'subject'->>'did' AS endorsement_subject_did
  FROM happyview_records AS award
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN pg_input_is_valid(award.record, 'jsonb')
        THEN award.record::jsonb
      ELSE NULL::jsonb
    END AS value
  ) AS award_json
  JOIN happyview_records AS definition
    -- Match the exact definition version referenced by the award.
    ON definition.uri = award_json.value->'badge'->>'uri'
   AND definition.cid = award_json.value->'badge'->>'cid'
   AND definition.collection = 'app.certified.badge.definition'
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN pg_input_is_valid(definition.record, 'jsonb')
        THEN definition.record::jsonb
      ELSE NULL::jsonb
    END AS value
  ) AS definition_json
  WHERE award.collection = 'app.certified.badge.award'
    AND definition_json.value->>'badgeType' = 'endorsement'
    AND (
      -- Omitting allowedIssuers permits any issuer. When present, it must be an
      -- array containing this issuer; malformed values deliberately match none.
      NOT (definition_json.value ? 'allowedIssuers')
      OR (
        jsonb_typeof(definition_json.value->'allowedIssuers') = 'array'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(definition_json.value->'allowedIssuers') = 'array'
                THEN definition_json.value->'allowedIssuers'
              ELSE '[]'::jsonb
            END
          ) AS issuer(did)
          WHERE issuer.did = award.did
        )
      )
    )
    -- Only account-target endorsements affect scope or appear as feed events.
    AND jsonb_typeof(award_json.value->'subject') = 'object'
    AND award_json.value->'subject'->>'$type' = 'app.certified.defs#did'
    AND jsonb_typeof(award_json.value->'subject'->'did') = 'string'
    AND char_length(award_json.value->'subject'->>'did') <= 2048
    AND award_json.value->'subject'->>'did' ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$'
    -- Self-endorsements neither expand scope nor produce feed events.
    AND award.did <> award_json.value->'subject'->>'did'
    AND COALESCE(
      (
        SELECT response_json.value->>'response'
        FROM happyview_records AS response
        CROSS JOIN timestamp_patterns AS timestamp_pattern
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN pg_input_is_valid(response.record, 'jsonb')
              THEN response.record::jsonb
            ELSE NULL::jsonb
          END AS value
        ) AS response_json
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN (
              response.indexed_at ~ timestamp_pattern.rfc3339_timestamp_pattern
              OR response.indexed_at ~ timestamp_pattern.postgres_timestamp_pattern
            )
              AND response.indexed_at !~ timestamp_pattern.postgres_unknown_offset_suffix_pattern
              AND pg_input_is_valid(response.indexed_at, 'timestamp with time zone')
              THEN CASE
                WHEN isfinite(response.indexed_at::timestamptz)
                  THEN response.indexed_at::timestamptz
                ELSE NULL::timestamptz
              END
            ELSE NULL::timestamptz
          END AS value
        ) AS response_indexed_at
        CROSS JOIN LATERAL (
          SELECT COALESCE(
            CASE
              WHEN jsonb_typeof(response_json.value->'createdAt') = 'string'
                AND response_json.value->>'createdAt' ~ timestamp_pattern.rfc3339_timestamp_pattern
                AND response_json.value->>'createdAt' !~ timestamp_pattern.rfc3339_unknown_offset_suffix_pattern
                AND pg_input_is_valid(
                  response_json.value->>'createdAt',
                  'timestamp with time zone'
                )
                THEN (response_json.value->>'createdAt')::timestamptz
              ELSE NULL::timestamptz
            END,
            response_indexed_at.value
          ) AS effective_at
        ) AS response_time
        WHERE response.collection = 'app.certified.badge.response'
          AND response.did = award_json.value->'subject'->>'did'
          AND response_json.value->'badgeAward'->>'uri' = award.uri
          AND response_json.value->'badgeAward'->>'cid' = award.cid
          AND response_json.value->>'response' IS NOT NULL
          AND response_json.value->>'response' <> ''
          AND response_time.effective_at IS NOT NULL
        -- Compare validated timestamp values, never the stored text lexically.
        ORDER BY
          response_time.effective_at DESC,
          response_indexed_at.value DESC NULLS LAST,
          response.uri DESC
        LIMIT 1
      ),
      ''
    ) <> 'rejected'
),
evaluator_endorsements AS (
  SELECT award.endorsement_subject_did AS did
  FROM valid_endorsement_awards AS award
  WHERE award.did = ANY($2::text[])
),
requested_scope AS (
  SELECT DISTINCT candidate.did
  FROM (
    SELECT did FROM base_authors
    UNION ALL
    SELECT did FROM evaluator_endorsements
  ) AS candidate
  WHERE candidate.did IS NOT NULL
    AND candidate.did <> $1
),
-- HappyView stores only the current positive label projection. Its timestamps
-- are TEXT; validate their shape and finiteness before any timestamp cast.
active_quality_labels AS (
  SELECT scoped.did, label.val
  FROM requested_scope AS scoped
  JOIN happyview_labels AS label
    ON label.uri = scoped.did
  CROSS JOIN timestamp_patterns AS timestamp_pattern
  WHERE label.src = ANY($6::text[])
    AND label.val = ANY(
      ARRAY['high-quality', 'standard', 'draft', 'likely-test']::text[]
    )
    AND CASE
      WHEN (
        label.cts ~ timestamp_pattern.rfc3339_timestamp_pattern
        OR label.cts ~ timestamp_pattern.postgres_timestamp_pattern
      )
        AND label.cts !~ timestamp_pattern.postgres_unknown_offset_suffix_pattern
        AND pg_input_is_valid(label.cts, 'timestamp with time zone')
        THEN isfinite(label.cts::timestamptz)
      ELSE false
    END
    AND CASE
      WHEN label.exp IS NULL THEN true
      WHEN (
        label.exp ~ timestamp_pattern.rfc3339_timestamp_pattern
        OR label.exp ~ timestamp_pattern.postgres_timestamp_pattern
      )
        AND label.exp !~ timestamp_pattern.postgres_unknown_offset_suffix_pattern
        AND pg_input_is_valid(label.exp, 'timestamp with time zone')
        THEN isfinite(label.exp::timestamptz)
          AND label.exp::timestamptz > NOW()
      ELSE false
    END
),
quality_summary AS (
  SELECT
    quality.did,
    bool_or(quality.val = ANY($4::text[])) AS has_allowed
  FROM active_quality_labels AS quality
  GROUP BY quality.did
),
final_scope AS (
  SELECT scoped.did
  FROM requested_scope AS scoped
  LEFT JOIN quality_summary AS quality ON quality.did = scoped.did
  WHERE NOT $3::boolean
     OR NOT EXISTS (
       SELECT 1
       FROM happyview_records AS organization
       WHERE organization.uri =
         'at://' || scoped.did || '/app.certified.actor.organization/self'
         AND organization.collection = 'app.certified.actor.organization'
     )
     OR COALESCE(quality.has_allowed, false)
     OR (quality.did IS NULL AND $5::boolean)
),
-- Materialize the complete resolved scope once for project and event selection.
resolved_scope AS MATERIALIZED (
  SELECT scoped.did
  FROM final_scope AS scoped
),
-- =============================================================================
-- Project pairing
-- A collection and its referenced activity become one project-created event
-- when the records belong to the same actor and effective times are close.
-- =============================================================================
project_pairs AS (
  SELECT DISTINCT collection_record.uri AS collection_uri, activity.uri AS activity_uri
  FROM resolved_scope AS scoped
  JOIN happyview_records AS collection_record
    ON collection_record.did = scoped.did
   AND collection_record.collection = 'org.hypercerts.collection'
  CROSS JOIN timestamp_patterns AS timestamp_pattern
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN pg_input_is_valid(collection_record.record, 'jsonb')
        THEN collection_record.record::jsonb
      ELSE NULL::jsonb
    END AS value
  ) AS collection_json
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN (
        collection_record.indexed_at ~ timestamp_pattern.rfc3339_timestamp_pattern
        OR collection_record.indexed_at ~ timestamp_pattern.postgres_timestamp_pattern
      )
        AND collection_record.indexed_at !~ timestamp_pattern.postgres_unknown_offset_suffix_pattern
        AND pg_input_is_valid(collection_record.indexed_at, 'timestamp with time zone')
        THEN CASE
          WHEN isfinite(collection_record.indexed_at::timestamptz)
            THEN collection_record.indexed_at::timestamptz
          ELSE NULL::timestamptz
        END
      ELSE NULL::timestamptz
    END AS value
  ) AS collection_indexed_at
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      CASE
        WHEN jsonb_typeof(collection_json.value->'createdAt') = 'string'
          AND collection_json.value->>'createdAt' ~ timestamp_pattern.rfc3339_timestamp_pattern
          AND collection_json.value->>'createdAt' !~ timestamp_pattern.rfc3339_unknown_offset_suffix_pattern
          AND pg_input_is_valid(
            collection_json.value->>'createdAt',
            'timestamp with time zone'
          )
          THEN (collection_json.value->>'createdAt')::timestamptz
        ELSE NULL::timestamptz
      END,
      collection_indexed_at.value
    ) AS effective_at
  ) AS collection_time
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(collection_json.value->'items') = 'array'
        THEN collection_json.value->'items'
      ELSE '[]'::jsonb
    END
  ) AS item
  JOIN happyview_records AS activity
    ON activity.uri = item->'itemIdentifier'->>'uri'
   AND activity.cid = item->'itemIdentifier'->>'cid'
   AND activity.collection = 'org.hypercerts.claim.activity'
   AND activity.did = collection_record.did
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN pg_input_is_valid(activity.record, 'jsonb')
        THEN activity.record::jsonb
      ELSE NULL::jsonb
    END AS value
  ) AS activity_json
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN (
        activity.indexed_at ~ timestamp_pattern.rfc3339_timestamp_pattern
        OR activity.indexed_at ~ timestamp_pattern.postgres_timestamp_pattern
      )
        AND activity.indexed_at !~ timestamp_pattern.postgres_unknown_offset_suffix_pattern
        AND pg_input_is_valid(activity.indexed_at, 'timestamp with time zone')
        THEN CASE
          WHEN isfinite(activity.indexed_at::timestamptz)
            THEN activity.indexed_at::timestamptz
          ELSE NULL::timestamptz
        END
      ELSE NULL::timestamptz
    END AS value
  ) AS activity_indexed_at
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      CASE
        WHEN jsonb_typeof(activity_json.value->'createdAt') = 'string'
          AND activity_json.value->>'createdAt' ~ timestamp_pattern.rfc3339_timestamp_pattern
          AND activity_json.value->>'createdAt' !~ timestamp_pattern.rfc3339_unknown_offset_suffix_pattern
          AND pg_input_is_valid(
            activity_json.value->>'createdAt',
            'timestamp with time zone'
          )
          THEN (activity_json.value->>'createdAt')::timestamptz
        ELSE NULL::timestamptz
      END,
      activity_indexed_at.value
    ) AS effective_at
  ) AS activity_time
  WHERE collection_json.value IS NOT NULL
    AND activity_json.value IS NOT NULL
    AND collection_time.effective_at IS NOT NULL
    AND activity_time.effective_at IS NOT NULL
    AND ABS(EXTRACT(EPOCH FROM (
      activity_time.effective_at - collection_time.effective_at
    ))) < 60
),
paired_collections AS (
  SELECT DISTINCT collection_uri AS uri FROM project_pairs
),
paired_activities AS (
  SELECT DISTINCT activity_uri AS uri FROM project_pairs
),
-- =============================================================================
-- Record eligibility
-- Select supported records, suppress paired activity duplicates, admit only
-- update attachments, and enforce the shared endorsement policy.
-- =============================================================================
eligible_records AS (
  SELECT
    source.uri,
    source.cid,
    source.collection,
    source.did,
    source_time.effective_at
  FROM resolved_scope AS scoped
  JOIN happyview_records AS source
    ON source.did = scoped.did
   AND source.collection = ANY($11::text[])
  CROSS JOIN timestamp_patterns AS timestamp_pattern
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN pg_input_is_valid(source.record, 'jsonb')
        THEN source.record::jsonb
      ELSE NULL::jsonb
    END AS value
  ) AS source_json
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN (
        source.indexed_at ~ timestamp_pattern.rfc3339_timestamp_pattern
        OR source.indexed_at ~ timestamp_pattern.postgres_timestamp_pattern
      )
        AND source.indexed_at !~ timestamp_pattern.postgres_unknown_offset_suffix_pattern
        AND pg_input_is_valid(source.indexed_at, 'timestamp with time zone')
        THEN CASE
          WHEN isfinite(source.indexed_at::timestamptz)
            THEN source.indexed_at::timestamptz
          ELSE NULL::timestamptz
        END
      ELSE NULL::timestamptz
    END AS value
  ) AS source_indexed_at
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      CASE
        WHEN jsonb_typeof(source_json.value->'createdAt') = 'string'
          AND source_json.value->>'createdAt' ~ timestamp_pattern.rfc3339_timestamp_pattern
          AND source_json.value->>'createdAt' !~ timestamp_pattern.rfc3339_unknown_offset_suffix_pattern
          AND pg_input_is_valid(
            source_json.value->>'createdAt',
            'timestamp with time zone'
          )
          THEN (source_json.value->>'createdAt')::timestamptz
        ELSE NULL::timestamptz
      END,
      source_indexed_at.value
    ) AS effective_at
  ) AS source_time
  WHERE source_time.effective_at IS NOT NULL
    AND (
      source.collection <> 'org.hypercerts.claim.activity'
      OR NOT EXISTS (
        SELECT 1 FROM paired_activities WHERE paired_activities.uri = source.uri
      )
    )
    AND (
      source.collection <> 'org.hypercerts.context.attachment'
      OR source_json.value->>'contentType' = 'update'
    )
    AND (
      source.collection <> 'app.certified.badge.award'
      OR EXISTS (
        SELECT 1
        FROM valid_endorsement_awards AS award
        WHERE award.uri = source.uri
          AND award.cid = source.cid
      )
    )
),
-- =============================================================================
-- Event classification and pagination
-- Convert eligible records into public event kinds, apply keyset pagination,
-- and return one limit-plus-one page.
-- =============================================================================
classified_events AS (
  SELECT
    source.uri,
    source.cid,
    source.collection,
    source.did AS actor_did,
    CASE source.collection
      WHEN 'org.hypercerts.claim.activity' THEN 'cert.create'
      WHEN 'org.hypercerts.collection' THEN
        CASE
          WHEN EXISTS (
            SELECT 1 FROM paired_collections WHERE paired_collections.uri = source.uri
          ) THEN 'project.created_with_cert'
          ELSE 'collection.create'
        END
      WHEN 'org.hypercerts.context.evaluation' THEN 'evaluation.create'
      WHEN 'org.hypercerts.context.measurement' THEN 'measurement.create'
      WHEN 'org.hypercerts.context.attachment' THEN 'update.create'
      WHEN 'app.certified.badge.award' THEN 'endorsement.award'
    END AS kind,
    source.effective_at
  FROM eligible_records AS source
),
filtered_events AS (
  SELECT event.*
  FROM classified_events AS event
  WHERE (cardinality($7::text[]) = 0 OR event.kind = ANY($7::text[]))
    AND (
      $8::timestamptz IS NULL
      OR event.effective_at < $8::timestamptz
      -- URI is the deterministic tie-breaker for equal timestamps.
      OR (event.effective_at = $8::timestamptz AND event.uri < $9::text)
    )
),
paged_events AS (
  SELECT *
  FROM filtered_events
  ORDER BY effective_at DESC, uri DESC
  LIMIT $10::integer
)
SELECT
  page.uri,
  page.cid,
  page.collection,
  page.actor_did,
  page.kind,
  to_char(
    page.effective_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS sort_value,
  selected_source.uri AS selected_source_uri,
  selected_source.cid AS selected_source_cid,
  selected_source.collection AS selected_source_collection,
  selected_source.record AS source_json
FROM paged_events AS page
LEFT JOIN happyview_records AS selected_source
  ON $12::boolean
 AND selected_source.uri = page.uri
 AND selected_source.cid = page.cid
 AND selected_source.collection = page.collection
ORDER BY page.effective_at DESC, page.uri DESC
