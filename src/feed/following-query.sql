-- GainForest following feed rows over Hyperindex's `record` table.
--
-- A plain read, like feed-query.sql: the next $4 selectable rows after the
-- cursor, newest first, for the active kinds, restricted to what the accounts
-- the viewer follows have published. The rows, columns, order, and cursor are
-- the activity statement's, so the same batch loop and page builder fold them
-- into cards. What differs is where it starts: from the followed accounts, not
-- from the collections.
--
-- Parameters
--   $1  kinds       text[]       active kinds: project, observation, organization, post, repost, audio
--   $2  cursor_ts   timestamptz  position of the last row the previous page consumed, or null
--   $3  cursor_uri  text         tie-breaker for $2, or null
--   $4  batch_rows  integer      most rows to return
--   $5  viewer      text         DID of the account whose follows scope the feed
--   $6  max_follows integer      most followed accounts read; the most recently followed win
--
-- Selection is the activity feed's: valid rows only, a non-null
-- `record_created_at` inside the range guard (written out in every read, see
-- feed-query.sql), the same kind rules (projects typed project or Project,
-- top-level posts without the community-event tag, reposts whose subject is a
-- valid feed record of another account, observations, organizations), and the
-- same row columns. Only the follow scope is added:
--   * follows: the subjects of the viewer's valid `app.certified.graph.follow`
--     records, at most $6 accounts, newest follow first. An account counts once,
--     at its newest follow record, so duplicate follow records of one account
--     never use up the cap. A follow whose subject is not a string is not a
--     follow.
--   * project, organization, post, observation: the records a followed account
--     stored. repost: the reposts a followed account stored (the reposter's).
--   * audio: scoped to the owner of the recorder folder, not to the account that
--     stored the recording (`audio_keyed` is feed-query.sql's, word for word: a
--     test compares the two). Two sets, never both for one recording:
--       - `authored`: a followed account's own recordings whose owner is that
--         account: no folder, a folder it owns, or a folder whose authority is
--         a handle or anything else that is not a valid DID.
--       - `folder_audio`: recordings whose owner is another account, whoever
--         stored them, when `deploymentRef` is the AT-URI of a valid
--         `app.gainforest.ac.deployment` record a followed account stores.
--         A recording a followed account stored in a folder nobody followed
--         owns is therefore left out; so is a recording that names a folder
--         that does not exist, unless a followed account stored it itself in
--         its own folder.
--     A recording is shown at the owner's: `owner` is its folder's owner.
--
-- Plan shape. Keep these choices; each is there for the planner (EXPLAIN ANALYZE
-- on a table of production shape before changing any):
--   * Follow-driven. `follows` is the outer side of one LATERAL read per kind
--     and followed account, which walks idx_record_timeline_author_collection_created
--     (`did, collection, record_created_at DESC, uri DESC`) in order, from the
--     cursor, for at most $4 rows. The cost is a few index reads per followed
--     account and kind, whatever the size of the collections. A viewer who
--     follows nobody runs no LATERAL read and reads no collection.
--   * The limits are `(SELECT $4)` and `(SELECT $6)`, numbers PostgreSQL cannot
--     see, for the reason given in feed-query.sql: with a visible limit and a
--     selective filter it leaves the ordered index scan for a bitmap scan and a
--     sort of everything the account stored.
--   * The cursor is an inline predicate on $2 and $3, never a CTE, so it is an
--     index condition and a deep page costs what the first page costs.
--   * `authored` keeps only the newest $4 rows of all those reads (a top-N
--     sort), so one statement holds at most $4 of them whatever the viewer
--     follows.
--   * The bioacoustic flag of an observation is read last, by primary key, for
--     the observations the batch returns only: reading it in the arms costs a
--     record read for every row of every followed account. The key is NULL for
--     a row of any other kind, which matches nothing and reads no page (the
--     kind test must be in the key: as a separate condition PostgreSQL applies
--     it after the lookup has already read a page for every row).
--   * The read of a followed account's own recordings keeps those whose owner is
--     the account (`owner = did`), which no index can answer. PostgreSQL
--     estimates a few dozen recordings per account and plans a bitmap scan and
--     a sort: it reads all of the account's recordings after the cursor,
--     whatever LIMIT says (for some cursors it chooses the ordered scan
--     instead, which stops at the limit). That is cheap for an account with
--     hundreds of recordings and costs about 2 to 4 microseconds per recording
--     for one with tens of thousands, an organization with a large archive of
--     its own recordings included. The owner index proposed in
--     docs/database-contract.md answers it.
--   * Hyperindex has no index on `deploymentRef` (migrations 001 through 014),
--     so a recording cannot be found by its folder. `folder_audio` is the one
--     read that is not driven by an index on what it filters:
--       - It walks idx_record_timeline_collection_created, newest first, from the
--         cursor, and stops after $4 recordings of followed folders.
--       - It is skipped (one-time filter) when the followed accounts own no
--         folder, so such a viewer never pays for it.
--       - A recording older than the last row of `authored`, once `authored`
--         holds a full batch, cannot be on the page, so `batch_end` bounds the
--         walk from below. When the followed accounts store few rows, there is
--         no such bound and the walk can read every recording after the cursor:
--         a cost proportional to the audio collection, until Hyperindex gets
--         the index proposed in docs/database-contract.md.
--   * `COALESCE(x IN (SELECT ...), false)` keeps the list a hashed lookup.
--     PostgreSQL estimates `follows` and `folders` at one row, and turns a
--     plain `IN (SELECT ...)` into a nested loop that reads the whole list for
--     every recording it checks.
WITH
-- The accounts the viewer follows, newest follow first, at most $6 accounts. The
-- newest follow record of an account (DISTINCT ON) decides its place, so an
-- account followed twice counts once; `uri` makes the order total, so every
-- statement of a request reads the same accounts. The cap bounds what the
-- statement reads for the followed accounts, not this read: it reads every
-- follow record the viewer has, through idx_record_did_collection (a follow
-- without a usable createdAt still counts, which the partial author index could
-- not return), and sorts them to find each account's newest, so it is linear in
-- them (a bit more than linear for the sort). The sort compares the subjects as
-- bytes (COLLATE "C"): telling equal strings apart needs no locale, and the
-- locale comparison made this sort about three times slower for 100,000 follow
-- records.
follows AS MATERIALIZED (
  SELECT newest.did
  FROM (
    SELECT DISTINCT ON ((follow.json->>'subject') COLLATE "C")
           follow.json->>'subject' AS did, follow.record_created_at, follow.uri
    FROM record AS follow
    WHERE follow.collection = 'app.certified.graph.follow'
      AND follow.did = $5::text
      AND follow.validation_status = 'valid'
      AND jsonb_typeof(follow.json->'subject') = 'string'
    ORDER BY (follow.json->>'subject') COLLATE "C", follow.record_created_at DESC NULLS LAST, follow.uri DESC
  ) AS newest
  ORDER BY newest.record_created_at DESC NULLS LAST, newest.uri DESC
  LIMIT (SELECT $6::integer)
),
-- The recorder folders the followed accounts own.
folders AS MATERIALIZED (
  SELECT folder.uri
  FROM follows AS f
  CROSS JOIN LATERAL (
    SELECT d.uri
    FROM record AS d
    WHERE d.did = f.did
      AND d.collection = 'app.gainforest.ac.deployment'
      AND d.validation_status = 'valid'
  ) AS folder
),
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
-- What the followed accounts stored themselves, newest $4 rows. Every kind is
-- one LATERAL read per followed account, in index order, from the cursor.
authored AS MATERIALIZED (
  SELECT 'project'::text AS kind, p.uri, p.cid, p.did, p.ts,
         NULL::text AS owner, NULL::text AS folder, NULL::text AS subject
  FROM follows AS f
  CROSS JOIN LATERAL (
    SELECT r.uri, r.cid, r.did, r.record_created_at AS ts
    FROM record AS r
    WHERE r.did = f.did
      AND r.collection = 'org.hypercerts.collection'
      AND r.record_created_at IS NOT NULL
      AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
      AND ($2::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($2::timestamptz, $3::text))
      AND r.validation_status = 'valid'
      AND r.json->>'type' IN ('project', 'Project')
    ORDER BY r.record_created_at DESC, r.uri DESC
    LIMIT (SELECT $4::integer)
  ) AS p
  WHERE 'project' = ANY($1::text[])
  UNION ALL
  SELECT 'organization', p.uri, p.cid, p.did, p.ts, NULL, NULL, NULL
  FROM follows AS f
  CROSS JOIN LATERAL (
    SELECT r.uri, r.cid, r.did, r.record_created_at AS ts
    FROM record AS r
    WHERE r.did = f.did
      AND r.collection = 'app.certified.actor.organization'
      AND r.record_created_at IS NOT NULL
      AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
      AND ($2::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($2::timestamptz, $3::text))
      AND r.validation_status = 'valid'
    ORDER BY r.record_created_at DESC, r.uri DESC
    LIMIT (SELECT $4::integer)
  ) AS p
  WHERE 'organization' = ANY($1::text[])
  UNION ALL
  -- Top-level posts only; replies are comments. Event announcements are not
  -- activity either.
  SELECT 'post', p.uri, p.cid, p.did, p.ts, NULL, NULL, NULL
  FROM follows AS f
  CROSS JOIN LATERAL (
    SELECT r.uri, r.cid, r.did, r.record_created_at AS ts
    FROM record AS r
    WHERE r.did = f.did
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
    LIMIT (SELECT $4::integer)
  ) AS p
  WHERE 'post' = ANY($1::text[])
  UNION ALL
  -- A repost counts only while its subject still exists and would itself be a
  -- feed record: a valid project (type project or Project), observation, or
  -- top-level non-event post, owned by another account. The row is the
  -- reposter's, and the reposter is the followed account.
  SELECT 'repost', p.uri, p.cid, p.did, p.ts, NULL, NULL, p.subject
  FROM follows AS f
  CROSS JOIN LATERAL (
    SELECT r.uri, r.cid, r.did, r.record_created_at AS ts, r.json->'subject'->>'uri' AS subject
    FROM record AS r
    WHERE r.did = f.did
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
    LIMIT (SELECT $4::integer)
  ) AS p
  WHERE 'repost' = ANY($1::text[])
  UNION ALL
  SELECT 'observation', p.uri, p.cid, p.did, p.ts, NULL, NULL, NULL
  FROM follows AS f
  CROSS JOIN LATERAL (
    SELECT r.uri, r.cid, r.did, r.record_created_at AS ts
    FROM record AS r
    WHERE r.did = f.did
      AND r.collection = 'app.gainforest.dwc.occurrence'
      AND r.record_created_at IS NOT NULL
      AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
      AND ($2::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($2::timestamptz, $3::text))
      AND r.validation_status = 'valid'
    ORDER BY r.record_created_at DESC, r.uri DESC
    LIMIT (SELECT $4::integer)
  ) AS p
  WHERE 'observation' = ANY($1::text[])
  UNION ALL
  -- The recordings a followed account stored itself and owns.
  SELECT 'audio', p.uri, p.cid, p.did, p.ts, p.owner, p.folder, NULL
  FROM follows AS f
  CROSS JOIN LATERAL (
    SELECT a.uri, a.cid, a.did, a.record_created_at AS ts, a.owner, a.folder
    FROM audio_keyed AS a
    WHERE a.did = f.did
      AND a.collection = 'app.gainforest.ac.audio'
      AND a.record_created_at IS NOT NULL
      AND a.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
      AND ($2::timestamptz IS NULL OR (a.record_created_at, a.uri) < ($2::timestamptz, $3::text))
      AND a.validation_status = 'valid'
      AND a.owner = a.did
    ORDER BY a.record_created_at DESC, a.uri DESC
    LIMIT (SELECT $4::integer)
  ) AS p
  WHERE 'audio' = ANY($1::text[])
  ORDER BY ts DESC, uri DESC
  LIMIT (SELECT $4::integer)
),
-- The last row of `authored` when it holds a full batch, and the oldest
-- possible position otherwise. Always exactly one row.
batch_end AS (
  SELECT COALESCE(last_row.ts, '-infinity'::timestamptz) AS ts,
         COALESCE(last_row.uri, '') AS uri
  FROM (SELECT 1) AS one
  LEFT JOIN (
    SELECT a.ts, a.uri
    FROM authored AS a
    ORDER BY a.ts DESC, a.uri DESC
    OFFSET (SELECT $4::integer) - 1
    LIMIT 1
  ) AS last_row ON true
),
-- Recordings whose owner is another account, found through the folders the
-- followed accounts own. See "Plan shape": nothing indexes `deploymentRef`.
folder_audio AS MATERIALIZED (
  SELECT 'audio'::text AS kind, a.uri, a.cid, a.did, a.record_created_at AS ts,
         a.owner, a.folder, NULL::text AS subject
  FROM audio_keyed AS a
  WHERE 'audio' = ANY($1::text[])
    AND EXISTS (SELECT 1 FROM folders)
    AND a.collection = 'app.gainforest.ac.audio'
    AND a.record_created_at IS NOT NULL
    AND a.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
    -- Older than the last row of a full batch: not on this page. The column
    -- bound ends the index scan; the row bound settles equal timestamps.
    AND a.record_created_at >= (SELECT b.ts FROM batch_end AS b)
    AND (a.record_created_at, a.uri) > ((SELECT b.ts FROM batch_end AS b), (SELECT b.uri FROM batch_end AS b))
    AND ($2::timestamptz IS NULL OR (a.record_created_at, a.uri) < ($2::timestamptz, $3::text))
    AND a.validation_status = 'valid'
    AND COALESCE(a.folder IN (SELECT uri FROM folders), false)
    AND a.owner <> a.did
  ORDER BY a.record_created_at DESC, a.uri DESC
  LIMIT (SELECT $4::integer)
)
SELECT b.kind,
       b.uri,
       -- Hyperindex stores an empty CID for records whose event carried none.
       NULLIF(b.cid, '') AS cid,
       b.did,
       to_char(b.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_value,
       b.owner,
       b.folder,
       COALESCE(sidecar.bioacoustic, false) AS bioacoustic,
       b.subject
FROM (
  -- Both sets have the same columns, in the same order.
  SELECT * FROM authored
  UNION ALL
  SELECT * FROM folder_audio
  ORDER BY ts DESC, uri DESC
  LIMIT (SELECT $4::integer)
) AS b
-- A bioacoustic sighting is an observation whose `dynamicProperties` text parses
-- to a `gainforestBioacoustics` sidecar with version 1, a known label category,
-- numeric time and frequency bounds, and a source audio URI that appears in
-- `associatedMedia`. Only the observations of the batch are looked up (any other
-- row has the key NULL, which reads no page), and the text is parsed only when
-- it mentions the sidecar.
LEFT JOIN LATERAL (
  SELECT COALESCE(
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
         ) AS bioacoustic
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
  WHERE r.uri = CASE WHEN b.kind = 'observation' THEN b.uri END
) AS sidecar ON true
ORDER BY b.ts DESC, b.uri DESC
