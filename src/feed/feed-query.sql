-- GainForest activity feed over Hyperindex's `record` table.
--
-- Parameters
--   $1  kinds        text[]       active kinds: project, observation, organization, post, repost, audio
--   $2  following    boolean      limit to accounts $3 follows
--   $3  viewer       text         viewer DID, used only when $2 is true
--   $4  cursor_ts    timestamptz  position of the last row the previous page consumed, or null
--   $5  cursor_uri   text         tie-breaker for $4, or null
--   $6  fetch_limit  integer      page size + 1; the extra item only proves a next page exists
--   $7  scan_rows    integer      most rows read from the merged feed order: (page size) * $10 + 1.
--                                 Every item covers at most $10 rows, so the page's items cover at
--                                 most (page size) * $10 rows. One more row, the first row of the
--                                 item after the page, proves that a next page exists and tells
--                                 whether the page's last chunk continues. One statement therefore
--                                 always settles a page; there is no retry with a wider window.
--                                 It is a bound, not a quantity the statement always reads: see
--                                 "Shape" below.
--   $8  gap_seconds  integer      longest gap between neighbours inside one run
--   $9  sample_size  integer      most sample URIs one burst or audio item returns
--   $10 chunk_rows   integer      most rows one burst or audio item covers
--   $11 open_kind    text         kind ('observation' or 'audio') the cursor names for the run the
--                                 previous page cut at $10 rows and left open, or null. Nothing else
--                                 about that run travels in the cursor: the statement reads its
--                                 account and folder from the cursor row, see "Open run".
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
-- Runs: rows that are adjacent in the merged feed order, have the same kind and
-- the same key, and are no more than $8 seconds apart form one run.
--   observation: the key is the account. A bioacoustic sighting never joins.
--   audio:       the key is the owner and the folder. The folder is
--                `deploymentRef` when it is an AT-URI. Its owner is the account
--                in that AT-URI when that is a valid DID, whoever stored the
--                recording; without a folder, or when the authority is a handle
--                or anything else that is not a valid DID, the recording's own
--                account owns it (see `audio_keyed`).
-- Any other row between two rows, of another kind or another key, ends the run.
-- Every other kind is one item per row.
--
-- A run is cut into items ("chunks") of at most $10 rows, newest first. A chunk
-- after the first one `continued` the run; a chunk that is full and followed by
-- another row of the same run is `capped`.
--
-- Open run. A page ends at a chunk boundary. When its last chunk is `capped`, the
-- cursor names the run's kind ($11), and this page decides whether its first row
-- continues that run. The cursor row ($4, $5) is read by primary key and its
-- account and folder are derived here, with the same expressions the arms use
-- (`audio_keyed` for audio, the account for observations). The cursor therefore
-- carries no record content, and a crafted cursor cannot choose the account or
-- the folder. The row is the "previous row" of the page's first row. There is no
-- open run, and the first item starts a new one, when that row no longer exists,
-- is no longer valid or in range, is not of the named kind, or no longer has the
-- timestamp the cursor carries.
--
-- Result: one row per item, in feed order, up to the sentinel item. The
-- sentinel carries no group details because the caller never maps it.
--
-- Shape. The statement streams: `branches` is merged lazily, every level up to
-- `numbered` passes rows on as they arrive, and `numbered` ends the stream at the
-- first row of the item after the sentinel item. The whole sentinel chunk (up to
-- $10 rows) is therefore read, and never more than $7 rows. A page of ordinary
-- items reads a few hundred rows, and only a page made of full chunks reads the
-- whole $7. Keep these choices, each is there for the planner (EXPLAIN ANALYZE
-- on a production-shaped table before changing any):
--   * The cursor is a predicate on $4 and $5, not a CTE. PostgreSQL then uses it
--     as an index condition on the timeline index, so a deep page costs what
--     the first page costs.
--   * The observation and audio arms and the merged stream take their limit
--     from a subquery. With a literal limit PostgreSQL leaves the ordered index
--     scan for a bitmap scan and a sort of the whole collection, reading every
--     JSON and spilling to disk, once the limit passes about a third of the
--     collection. A limit it cannot see makes it plan for the first tenth.
--   * `item_no` is count(*) FILTER (...): of the window aggregates only
--     count(*) lets PostgreSQL stop the window early (a "run condition").
--   * A subquery that has window functions is not inlined into its user, so
--     the expression that reads a record is computed once per row. `checked`
--     has row_number() for that reason; `audio_keyed` uses OFFSET 0.
--   * Every arm starts with `EXISTS (SELECT 1 FROM follows)` when $2 is true.
--     PostgreSQL runs it once, as a one-time filter. Without it a viewer who
--     follows nobody, or nobody with matching rows, makes every arm walk its
--     whole collection for a filter that nothing passes.
--   * Arms carry no record content. `has_sidecar_text` is a cheap test on the
--     observation's text; only the few rows that pass it have their record
--     read, in `checked`, by primary key.
WITH
-- Accounts the viewer currently follows. Only read when $2 is true.
follows AS (
  SELECT DISTINCT follow.json->>'subject' AS did
  FROM record AS follow
  WHERE $2::boolean
    AND follow.collection = 'app.certified.graph.follow'
    AND follow.did = $3::text
    AND follow.validation_status = 'valid'
    AND jsonb_typeof(follow.json->'subject') = 'string'
),
-- Audio recordings with the key that groups them: the owner and the folder. The
-- folder is `deploymentRef` when it is an AT-URI. Its owner is the AT-URI's
-- authority when that is a valid DID (`did:method:id`, at most 2,048 characters,
-- no trailing ':' or '%', the shape the Lexicon's `did` format accepts), and the
-- recording's own account otherwise. `audioItem.did` is therefore always a DID,
-- whatever a record stores. NOT MATERIALIZED: the audio arm and the open-run
-- lookup both inline it. The OFFSET 0 levels make PostgreSQL read
-- `deploymentRef` and split the authority once per row.
audio_keyed AS NOT MATERIALIZED (
  SELECT r.uri, r.collection, r.record_created_at, r.validation_status,
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
-- The run the previous page left open, read from the cursor row (see "Open run").
-- At most one row; none when $11 is null, which is every first page.
open_run AS (
  SELECT 'audio'::text AS kind, a.owner AS did, a.folder AS deployment
  FROM audio_keyed AS a
  WHERE $11::text = 'audio'
    AND a.uri = $5::text
    AND a.collection = 'app.gainforest.ac.audio'
    AND a.record_created_at = $4::timestamptz
    AND a.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
    AND a.validation_status = 'valid'
  UNION ALL
  SELECT 'observation', r.did, NULL
  FROM record AS r
  WHERE $11::text = 'observation'
    AND r.uri = $5::text
    AND r.collection = 'app.gainforest.dwc.occurrence'
    AND r.record_created_at = $4::timestamptz
    AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
    AND r.validation_status = 'valid'
),
-- Every kind contributes its newest rows in feed order, lazily: the merge below
-- asks each arm for one row at a time. A kind whose rows are one item each can
-- add at most $6 rows to a page. Observations and audio form runs, so they may
-- add up to $7. A row carries the kind, the owning account (for audio the
-- folder's owner), the audio folder, and whether an observation's text mentions
-- a bioacoustic sidecar. A record's content is read only where a later step
-- needs it.
branches AS (
  (SELECT 'project'::text AS kind, r.uri, r.did, r.record_created_at AS ts, NULL::text AS deployment, false AS has_sidecar_text
   FROM record AS r
   WHERE 'project' = ANY($1::text[])
     AND r.collection = 'org.hypercerts.collection'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND ($4::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($4::timestamptz, $5::text))
     AND r.validation_status = 'valid'
     AND r.json->>'type' IN ('project', 'Project')
     AND (NOT $2::boolean OR EXISTS (SELECT 1 FROM follows))
     AND (NOT $2::boolean OR r.did IN (SELECT did FROM follows))
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT $6::integer)
  UNION ALL
  (SELECT 'organization', r.uri, r.did, r.record_created_at, NULL, false
   FROM record AS r
   WHERE 'organization' = ANY($1::text[])
     AND r.collection = 'app.certified.actor.organization'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND ($4::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($4::timestamptz, $5::text))
     AND r.validation_status = 'valid'
     AND (NOT $2::boolean OR EXISTS (SELECT 1 FROM follows))
     AND (NOT $2::boolean OR r.did IN (SELECT did FROM follows))
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT $6::integer)
  UNION ALL
  -- Top-level posts only; replies are comments. Event announcements are not
  -- activity either.
  (SELECT 'post', r.uri, r.did, r.record_created_at, NULL, false
   FROM record AS r
   WHERE 'post' = ANY($1::text[])
     AND r.collection = 'app.gainforest.feed.post'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND ($4::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($4::timestamptz, $5::text))
     AND r.validation_status = 'valid'
     AND r.json->>'reply' IS NULL
     AND NOT COALESCE(
       jsonb_typeof(r.json->'tags') = 'array' AND r.json->'tags' ? 'community-event',
       false
     )
     AND (NOT $2::boolean OR EXISTS (SELECT 1 FROM follows))
     AND (NOT $2::boolean OR r.did IN (SELECT did FROM follows))
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT $6::integer)
  UNION ALL
  -- A repost counts only while its subject still exists and would itself be a
  -- feed record: a valid project (type project or Project), observation, or
  -- top-level non-event post, owned by another account. The row is the
  -- reposter's.
  (SELECT 'repost', r.uri, r.did, r.record_created_at, NULL, false
   FROM record AS r
   WHERE 'repost' = ANY($1::text[])
     AND r.collection = 'app.gainforest.feed.repost'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND ($4::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($4::timestamptz, $5::text))
     AND r.validation_status = 'valid'
     AND (NOT $2::boolean OR EXISTS (SELECT 1 FROM follows))
     AND (NOT $2::boolean OR r.did IN (SELECT did FROM follows))
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
   LIMIT $6::integer)
  UNION ALL
  (SELECT 'audio', a.uri, a.owner, a.record_created_at, a.folder, false
   FROM audio_keyed AS a
   WHERE 'audio' = ANY($1::text[])
     AND a.collection = 'app.gainforest.ac.audio'
     AND a.record_created_at IS NOT NULL
     AND a.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND ($4::timestamptz IS NULL OR (a.record_created_at, a.uri) < ($4::timestamptz, $5::text))
     AND a.validation_status = 'valid'
     AND (NOT $2::boolean OR EXISTS (SELECT 1 FROM follows))
     AND (NOT $2::boolean OR a.owner IN (SELECT did FROM follows))
   ORDER BY a.record_created_at DESC, a.uri DESC
   LIMIT (SELECT $7::integer))
  UNION ALL
  (SELECT 'observation', r.uri, r.did, r.record_created_at, NULL,
          COALESCE(r.json->>'dynamicProperties' LIKE '%gainforestBioacoustics%', false)
   FROM record AS r
   WHERE 'observation' = ANY($1::text[])
     AND r.collection = 'app.gainforest.dwc.occurrence'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND ($4::timestamptz IS NULL OR (r.record_created_at, r.uri) < ($4::timestamptz, $5::text))
     AND r.validation_status = 'valid'
     AND (NOT $2::boolean OR EXISTS (SELECT 1 FROM follows))
     AND (NOT $2::boolean OR r.did IN (SELECT did FROM follows))
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT (SELECT $7::integer))
),
-- The merged feed order, cut at $7 rows.
stream AS (
  SELECT * FROM branches ORDER BY ts DESC, uri DESC LIMIT (SELECT $7::integer)
),
-- Which neighbours could belong to one run. For the first row the previous
-- row is the cursor row, when it opens a run (`open_run`). Only observations
-- next to an observation of the same account can be bioacoustic sightings that
-- matter, so only those rows are inspected below.
paired AS (
  SELECT s.*,
         COALESCE(
           s.kind IN ('observation', 'audio')
           AND s.kind = lag(s.kind, 1, (SELECT o.kind FROM open_run AS o)) OVER feed_order
           AND s.did = lag(s.did, 1, (SELECT o.did FROM open_run AS o)) OVER feed_order
           AND s.deployment IS NOT DISTINCT FROM lag(s.deployment, 1, (SELECT o.deployment FROM open_run AS o)) OVER feed_order
           AND lag(s.ts, 1, $4::timestamptz) OVER feed_order - s.ts <= make_interval(secs => $8::integer),
           false
         ) AS touches_previous,
         COALESCE(
           s.kind = 'observation'
           AND lead(s.kind) OVER feed_order = 'observation'
           AND lead(s.did) OVER feed_order = s.did,
           false
         ) AS may_touch_next
  FROM stream AS s
  WINDOW feed_order AS (ORDER BY s.ts DESC, s.uri DESC)
),
-- An observation with a valid bioacoustic sidecar is shown on its own, with
-- its spectrogram, so it never joins a burst. Its record is read here, by
-- primary key, and only when the answer matters. The row_number() makes this a
-- window subquery, which PostgreSQL does not inline into the next level: an
-- inlined subquery repeats its expressions once per use, and the lookup must
-- run once per row.
checked AS (
  SELECT p.*,
         CASE
           WHEN p.has_sidecar_text AND (p.touches_previous OR p.may_touch_next)
             THEN (
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
                      )
               FROM record AS r
               CROSS JOIN LATERAL (
                 SELECT CASE
                   WHEN jsonb_typeof(r.json->'dynamicProperties') = 'string'
                    AND r.json->>'dynamicProperties' LIKE '%gainforestBioacoustics%'
                    AND pg_input_is_valid(r.json->>'dynamicProperties', 'jsonb')
                     THEN (r.json->>'dynamicProperties')::jsonb->'gainforestBioacoustics'
                 END AS value
               ) AS segment
               WHERE r.uri = p.uri
             )
           ELSE false
         END AS bioacoustic,
         row_number() OVER (ORDER BY p.ts DESC, p.uri DESC) AS rn
  FROM paired AS p
),
-- A row joins the previous row's run when they touch and neither is a
-- bioacoustic sighting. Audio has no such exception.
flagged AS (
  SELECT c.*,
         COALESCE(
           c.touches_previous
           AND (c.kind = 'audio' OR (NOT c.bioacoustic AND NOT lag(c.bioacoustic, 1, false) OVER feed_order)),
           false
         ) AS joins_previous
  FROM checked AS c
  WINDOW feed_order AS (ORDER BY c.ts DESC, c.uri DESC)
),
-- The row number of the row that started the run this row is in. It is null
-- until the first run starts: those rows continue the run left open by the
-- previous page. `joins_next` tells whether the following row joins this run.
positioned AS (
  SELECT f.*,
         max(CASE WHEN NOT f.joins_previous THEN f.rn END) OVER feed_order AS run_head_rn,
         lead(f.joins_previous, 1, false) OVER feed_order AS joins_next
  FROM flagged AS f
  WINDOW feed_order AS (ORDER BY f.ts DESC, f.uri DESC)
),
-- Position of the row inside its run, counted from this page's first row of
-- the run, and the number of the item the row belongs to: a new item starts
-- at every run head and after every $10 rows of a run.
located AS (
  SELECT p.*, p.rn - COALESCE(p.run_head_rn, 1) + 1 AS pos_in_run
  FROM positioned AS p
),
numbered AS (
  SELECT counted.*
  FROM (
    SELECT l.*,
           count(*) FILTER (WHERE ((l.pos_in_run - 1) % $10::integer) = 0)
             OVER (ORDER BY l.ts DESC, l.uri DESC) AS item_no
    FROM located AS l
  ) AS counted
  WHERE counted.item_no <= $6::integer
),
-- Details of the page's own items. The sentinel is left out.
chunks AS (
  SELECT n.item_no,
         count(*)::integer AS row_count,
         (array_agg(n.ts ORDER BY n.ts ASC, n.uri ASC))[1] AS oldest_ts,
         (array_agg(n.uri ORDER BY n.ts ASC, n.uri ASC))[1] AS oldest_uri,
         (array_agg(n.uri ORDER BY n.ts DESC, n.uri DESC))[1:$9::integer] AS samples,
         bool_or(n.pos_in_run % $10::integer = 0 AND n.joins_next) AS capped
  FROM numbered AS n
  WHERE n.item_no < $6::integer
  GROUP BY n.item_no
),
-- The first row of each item, with whether the item continues a run.
items AS (
  SELECT n.item_no, n.kind, n.uri, n.did, n.ts, n.deployment,
         (n.run_head_rn IS NULL OR n.pos_in_run > $10::integer) AS continued,
         c.row_count, c.oldest_ts, c.oldest_uri, c.samples, COALESCE(c.capped, false) AS capped
  FROM numbered AS n
  LEFT JOIN chunks AS c ON c.item_no = n.item_no
  WHERE ((n.pos_in_run - 1) % $10::integer) = 0
    AND n.item_no <= $6::integer
)
SELECT item.item_no::integer AS item_no,
       item.kind,
       item.uri,
       -- Hyperindex stores an empty CID for records whose event carried none.
       NULLIF(head.cid, '') AS cid,
       item.did,
       to_char(item.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_value,
       CASE WHEN item.kind = 'repost' THEN head.json->'subject'->>'uri' END AS subject,
       item.deployment,
       item.row_count AS total,
       to_char(item.oldest_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS tail_sort_value,
       item.oldest_uri AS tail_uri,
       item.samples,
       item.continued,
       item.capped
FROM items AS item
JOIN record AS head ON head.uri = item.uri
ORDER BY item.item_no
