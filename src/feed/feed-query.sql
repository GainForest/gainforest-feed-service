-- GainForest activity feed rows over Hyperindex's `record` table.
--
-- A plain read: the next $4 selectable rows after the cursor, newest first, for
-- the active kinds. It decides which records are in the feed and describes each
-- one; src/feed/query.ts folds the rows into cards.
--
-- Parameters
--   $1  kinds       text[]       active kinds: project, observation, organization, post, repost, audio
--   $2  cursor_ts   timestamptz  position of the last row the previous page consumed, or null
--   $3  cursor_uri  text         tie-breaker for $2, or null
--   $4  batch_rows  integer      most rows to return
--
-- Feed order is record_created_at DESC, uri DESC: Hyperindex's materialized,
-- RFC3339-validated top-level `createdAt`. Rows with a null value are excluded.
-- Only `validation_status = 'valid'` rows are selected, matching what
-- Hyperindex's typed GraphQL collections expose.
--
-- Range guard: every read of `record` also requires
--   record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
-- createdAt is client-declared, so a year-10000 record could not be formatted
-- as a datetime and a record dated 2099 would sit at the top of the feed for
-- good. Rows outside the range are ignored until their time arrives. The bounds
-- are written out in each place, not taken from a CTE: the planner needs to see
-- them to keep reading the timeline index in order.
--
-- Columns, one row per record
--   kind         project, observation, organization, post, repost, or audio
--   uri, cid     the record; an empty CID, which Hyperindex stores for an event
--                that carried none, is returned as null
--   did          the account that stored the record
--   sort_value   record_created_at as YYYY-MM-DDTHH:MI:SS.UUUUUUZ: the cursor
--                position and the item's createdAt
--   owner        audio only: the account that owns the recording's folder
--   folder       audio only: `deploymentRef` when it is an AT-URI, else null
--   bioacoustic  observation only: whether it is a bioacoustic sighting
--   subject      repost only: the AT-URI of the reposted record
-- An audio recording's owner is the account in its folder's AT-URI when that is
-- a valid DID, whoever stored the recording; without a folder, or when the
-- authority is a handle or anything else that is not a valid DID, the recording's
-- own account owns it (see `audio_keyed`). A bioacoustic sighting is an
-- observation whose `dynamicProperties` text parses to a `gainforestBioacoustics`
-- sidecar with version 1, a known label category, numeric time and frequency
-- bounds, and a source audio URI that appears in `associatedMedia`.
--
-- Keep these choices, each is there for the planner (EXPLAIN ANALYZE on a
-- production-shaped table before changing any):
--   * The cursor is a predicate on $2 and $3, not a CTE. PostgreSQL then uses it
--     as an index condition on the timeline index, so a deep page costs what
--     the first page costs.
--   * Every arm is an ordered scan of the timeline index with its own LIMIT, and
--     the merged stream has the same ORDER BY and LIMIT, so PostgreSQL merges
--     the arms lazily and stops after $4 rows.
--   * Every LIMIT is `(SELECT $4)`, a number PostgreSQL cannot see, so it plans
--     for the first tenth of the rows. With a visible limit and a selective
--     filter it leaves the ordered index scan: it estimates about 9 rows for
--     the post arm where 3,000 match, and a page of posts then read the whole
--     collection through a bitmap scan and a sort. The estimated cost of the
--     statement therefore grows with the table (see `jit=off` in
--     src/database.ts).
--   * OFFSET 0 keeps a subquery from being inlined into its user, which would
--     repeat its expression once per use: the folder and owner of a recording,
--     and the sidecar of an observation, are each read once per row.
WITH
-- Audio recordings with the key that groups them: the owner and the folder. The
-- folder is `deploymentRef` when it is an AT-URI. Its owner is the AT-URI's
-- authority when that is a valid DID (`did:method:id`, at most 2,048 characters,
-- no trailing ':' or '%', the shape the Lexicon's `did` format accepts), and the
-- recording's own account otherwise. A group's `did` is therefore always a DID,
-- whatever a record stores.
audio_keyed AS NOT MATERIALIZED (
  SELECT r.uri, r.cid, r.did, r.collection, r.record_created_at, r.validation_status,
         audio_key.owner, audio_key.folder
  FROM record AS r
  CROSS JOIN LATERAL (
    SELECT CASE WHEN reference.value LIKE 'at://%' THEN reference.value END AS folder,
           CASE WHEN length(reference.authority) <= 2048
                 AND reference.authority ~ '^did:[a-z]+:[A-Za-z0-9._:%-]*[A-Za-z0-9._-]$'
                THEN reference.authority
                ELSE r.did
           END AS owner
    FROM (
      SELECT raw.value,
             CASE WHEN raw.value LIKE 'at://%' THEN split_part(raw.value, '/', 3) END AS authority
      FROM (SELECT r.json->>'deploymentRef' AS value OFFSET 0) AS raw
      OFFSET 0
    ) AS reference
  ) AS audio_key
),
-- Every kind contributes its newest rows in feed order, lazily: the merge below
-- asks each arm for one row at a time.
branches AS (
  (SELECT 'project'::text AS kind, r.uri, r.cid, r.did, r.record_created_at AS ts,
          NULL::text AS owner, NULL::text AS folder, false AS bioacoustic, NULL::text AS subject
   FROM record AS r
   WHERE 'project' = ANY($1::text[])
     AND r.collection = 'org.hypercerts.collection'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND ($2::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($2::timestamptz, $3::text))
     AND r.validation_status = 'valid'
     AND r.json->>'type' IN ('project', 'Project')
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT (SELECT $4::integer))
  UNION ALL
  (SELECT 'organization', r.uri, r.cid, r.did, r.record_created_at, NULL, NULL, false, NULL
   FROM record AS r
   WHERE 'organization' = ANY($1::text[])
     AND r.collection = 'app.certified.actor.organization'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND ($2::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($2::timestamptz, $3::text))
     AND r.validation_status = 'valid'
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT (SELECT $4::integer))
  UNION ALL
  -- Top-level posts only; replies are comments. Event announcements are not
  -- activity either.
  (SELECT 'post', r.uri, r.cid, r.did, r.record_created_at, NULL, NULL, false, NULL
   FROM record AS r
   WHERE 'post' = ANY($1::text[])
     AND r.collection = 'app.gainforest.feed.post'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND ($2::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($2::timestamptz, $3::text))
     AND r.validation_status = 'valid'
     AND r.json->>'reply' IS NULL
     AND NOT COALESCE(
       jsonb_typeof(r.json->'tags') = 'array' AND r.json->'tags' ? 'community-event',
       false
     )
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT (SELECT $4::integer))
  UNION ALL
  -- A repost counts only while its subject still exists and would itself be a
  -- feed record: a valid project (type project or Project), observation, or
  -- top-level non-event post, owned by another account. The row is the
  -- reposter's.
  (SELECT 'repost', r.uri, r.cid, r.did, r.record_created_at, NULL, NULL, false,
          r.json->'subject'->>'uri'
   FROM record AS r
   WHERE 'repost' = ANY($1::text[])
     AND r.collection = 'app.gainforest.feed.repost'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND ($2::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($2::timestamptz, $3::text))
     AND r.validation_status = 'valid'
     AND EXISTS (
       SELECT 1
       FROM record AS subject
       WHERE subject.uri = r.json->'subject'->>'uri'
         AND subject.did <> r.did
         AND subject.validation_status = 'valid'
         AND (
           subject.collection = 'app.gainforest.dwc.occurrence'
           OR (
             subject.collection = 'org.hypercerts.collection'
             AND subject.json->>'type' IN ('project', 'Project')
           )
           OR (
             subject.collection = 'app.gainforest.feed.post'
             AND subject.json->>'reply' IS NULL
             AND NOT COALESCE(
               jsonb_typeof(subject.json->'tags') = 'array' AND subject.json->'tags' ? 'community-event',
               false
             )
           )
         )
     )
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT (SELECT $4::integer))
  UNION ALL
  (SELECT 'audio', a.uri, a.cid, a.did, a.record_created_at, a.owner, a.folder, false, NULL
   FROM audio_keyed AS a
   WHERE 'audio' = ANY($1::text[])
     AND a.collection = 'app.gainforest.ac.audio'
     AND a.record_created_at IS NOT NULL
     AND a.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND ($2::timestamptz IS NULL OR (a.record_created_at, a.uri) < ($2::timestamptz, $3::text))
     AND a.validation_status = 'valid'
   ORDER BY a.record_created_at DESC, a.uri DESC
   LIMIT (SELECT $4::integer))
  UNION ALL
  -- The sidecar is read only for the observations whose text mentions it.
  (SELECT 'observation', r.uri, r.cid, r.did, r.record_created_at, NULL, NULL,
          COALESCE(
            segment.value IS NOT NULL
            AND jsonb_typeof(segment.value) = 'object'
            AND segment.value->'version' = '1'::jsonb
            AND jsonb_typeof(segment.value->'sourceAudioUri') = 'string'
            AND segment.value->>'labelCategory' IN ('bird', 'frog', 'insect', 'other', 'note')
            AND jsonb_typeof(segment.value->'startTimeSeconds') = 'number'
            AND jsonb_typeof(segment.value->'endTimeSeconds') = 'number'
            AND jsonb_typeof(segment.value->'minFrequencyHz') = 'number'
            AND jsonb_typeof(segment.value->'maxFrequencyHz') = 'number'
            AND segment.value->>'sourceAudioUri' = ANY(
              ARRAY(SELECT btrim(media) FROM unnest(string_to_array(r.json->>'associatedMedia', '|')) AS media)
            ),
            false
          ),
          NULL
   FROM record AS r
   CROSS JOIN LATERAL (
     SELECT CASE
       WHEN jsonb_typeof(r.json->'dynamicProperties') = 'string'
        AND r.json->>'dynamicProperties' LIKE '%gainforestBioacoustics%'
        AND pg_input_is_valid(r.json->>'dynamicProperties', 'jsonb')
         THEN (r.json->>'dynamicProperties')::jsonb->'gainforestBioacoustics'
     END AS value
     OFFSET 0
   ) AS segment
   WHERE 'observation' = ANY($1::text[])
     AND r.collection = 'app.gainforest.dwc.occurrence'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND ($2::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($2::timestamptz, $3::text))
     AND r.validation_status = 'valid'
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT (SELECT $4::integer))
)
SELECT b.kind,
       b.uri,
       -- Hyperindex stores an empty CID for records whose event carried none.
       NULLIF(b.cid, '') AS cid,
       b.did,
       to_char(b.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_value,
       b.owner,
       b.folder,
       b.bioacoustic,
       b.subject
FROM branches AS b
ORDER BY b.ts DESC, b.uri DESC
LIMIT (SELECT $4::integer)
