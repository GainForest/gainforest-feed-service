-- GainForest activity feed over Hyperindex's `record` table.
--
-- Parameters
--   $1 kinds        text[]       active kinds: project, observation, organization, post, repost, audio
--   $2 following    boolean      limit to accounts $3 follows
--   $3 viewer       text         viewer DID, used only when $2 is true
--   $4 cursor_ts    timestamptz  position of the last row the previous page consumed, or null
--   $5 cursor_uri   text         tie-breaker for $4, or null
--   $6 fetch_limit  integer      page size + 1; the extra item only proves a next page exists
--   $7 scan_rows    integer      most rows read from the merged feed order; the caller retries
--                                with a larger value while `complete` is false
--   $8 gap_seconds  integer      longest gap between neighbours inside one observation burst
--   $9 sample_size  integer      most sample URIs a burst or audio day returns
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
-- Result: one row per item, in feed order, plus the `complete` flag. When the
-- page has no items the result is a single row whose item columns are null.
WITH
params AS (
  SELECT COALESCE($4::timestamptz, 'infinity'::timestamptz) AS cursor_ts,
         COALESCE($5::text, '') AS cursor_uri
),
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
-- Audio groups follow the GainForest app's upload days. A recording that names
-- a recorder folder (`deploymentRef` is an AT-URI) belongs to that folder, and
-- the folder's owner, the account in the AT-URI, owns the group, whoever stored
-- the recording. A recording without a folder belongs to its own account. A
-- group is one owner, one folder (or none), and one UTC day. The `audio_key`
-- lateral subqueries below compute that key and must stay identical.
--
-- Audio: the newest $7 recordings below the cursor ...
audio_scan AS (
  SELECT r.uri, r.cid, r.record_created_at AS ts, audio_key.owner, audio_key.folder
  FROM record AS r
  CROSS JOIN params AS p
  CROSS JOIN LATERAL (
    SELECT CASE WHEN r.json->>'deploymentRef' LIKE 'at://%' THEN r.json->>'deploymentRef' END AS folder,
           CASE WHEN r.json->>'deploymentRef' LIKE 'at://did:%'
                THEN substring(r.json->>'deploymentRef' from '^at://([^/]+)')
                ELSE r.did
           END AS owner
  ) AS audio_key
  WHERE 'audio' = ANY($1::text[])
    AND r.collection = 'app.gainforest.ac.audio'
    AND r.record_created_at IS NOT NULL
    AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
    AND (r.record_created_at, r.uri) < (p.cursor_ts, p.cursor_uri)
    AND r.validation_status = 'valid'
    AND (NOT $2::boolean OR audio_key.owner IN (SELECT did FROM follows))
  ORDER BY r.record_created_at DESC, r.uri DESC
  LIMIT $7::integer
),
-- ... reduced to one head per group: the newest recording of that group. Only
-- the head enters the feed order, so the rest of a group never appears on a
-- later page. A group whose head sits at or above the cursor was emitted by an
-- earlier page and is skipped. Only a group on the cursor's own UTC day can
-- have such a head, so the check runs for those heads only.
audio_heads AS (
  SELECT head.uri, head.cid, head.ts, head.owner, head.folder
  FROM (
    SELECT scan.*,
           row_number() OVER (
             PARTITION BY scan.owner, scan.folder, (scan.ts AT TIME ZONE 'UTC')::date
             ORDER BY scan.ts DESC, scan.uri DESC
           ) AS position_in_group
    FROM audio_scan AS scan
  ) AS head
  CROSS JOIN params AS p
  WHERE head.position_in_group = 1
    AND CASE
      WHEN (head.ts AT TIME ZONE 'UTC')::date = (p.cursor_ts AT TIME ZONE 'UTC')::date
        THEN NOT EXISTS (
          SELECT 1
          FROM record AS emitted
          CROSS JOIN LATERAL (
            SELECT CASE WHEN emitted.json->>'deploymentRef' LIKE 'at://%' THEN emitted.json->>'deploymentRef' END AS folder,
                   CASE WHEN emitted.json->>'deploymentRef' LIKE 'at://did:%'
                        THEN substring(emitted.json->>'deploymentRef' from '^at://([^/]+)')
                        ELSE emitted.did
                   END AS owner
          ) AS audio_key
          WHERE emitted.collection = 'app.gainforest.ac.audio'
            AND emitted.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
            AND (emitted.record_created_at, emitted.uri) >= (p.cursor_ts, p.cursor_uri)
            AND emitted.record_created_at < (date_trunc('day', head.ts AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'
            AND emitted.validation_status = 'valid'
            AND audio_key.owner = head.owner
            AND audio_key.folder IS NOT DISTINCT FROM head.folder
        )
      ELSE true
    END
),
-- The oldest recording the audio scan read, when it stopped at its row limit.
audio_horizon AS (
  SELECT oldest.ts, oldest.uri
  FROM (SELECT count(*) AS scanned FROM audio_scan) AS size
  CROSS JOIN LATERAL (
    SELECT scan.ts, scan.uri
    FROM audio_scan AS scan
    ORDER BY scan.ts ASC, scan.uri ASC
    LIMIT 1
  ) AS oldest
  WHERE size.scanned >= $7::integer
),
-- Every kind contributes its newest rows in feed order. A kind that is never
-- part of a burst needs at most $6 rows, because each of its rows is a feed
-- item on its own. Observations can form long bursts, so they are read up to
-- $7 rows.
branches AS (
  (SELECT 'project'::text AS kind, r.uri, r.cid, r.did, r.record_created_at AS ts,
          NULL::text AS subject, NULL::text AS deployment, true AS burstable
   FROM record AS r, params AS p
   WHERE 'project' = ANY($1::text[])
     AND r.collection = 'org.hypercerts.collection'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND (r.record_created_at, r.uri) < (p.cursor_ts, p.cursor_uri)
     AND r.validation_status = 'valid'
     AND r.json->>'type' IN ('project', 'Project')
     AND (NOT $2::boolean OR r.did IN (SELECT did FROM follows))
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT $6::integer)
  UNION ALL
  (SELECT 'organization', r.uri, r.cid, r.did, r.record_created_at, NULL, NULL, true
   FROM record AS r, params AS p
   WHERE 'organization' = ANY($1::text[])
     AND r.collection = 'app.certified.actor.organization'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND (r.record_created_at, r.uri) < (p.cursor_ts, p.cursor_uri)
     AND r.validation_status = 'valid'
     AND (NOT $2::boolean OR r.did IN (SELECT did FROM follows))
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT $6::integer)
  UNION ALL
  -- Top-level posts only; replies are comments. Event announcements are not
  -- activity either.
  (SELECT 'post', r.uri, r.cid, r.did, r.record_created_at, NULL, NULL, true
   FROM record AS r, params AS p
   WHERE 'post' = ANY($1::text[])
     AND r.collection = 'app.gainforest.feed.post'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND (r.record_created_at, r.uri) < (p.cursor_ts, p.cursor_uri)
     AND r.validation_status = 'valid'
     AND r.json->>'reply' IS NULL
     AND NOT COALESCE(
       jsonb_typeof(r.json->'tags') = 'array' AND r.json->'tags' ? 'community-event',
       false
     )
     AND (NOT $2::boolean OR r.did IN (SELECT did FROM follows))
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT $6::integer)
  UNION ALL
  -- A repost counts only while its subject still exists and would itself be a
  -- feed record: a valid project (type project or Project), observation, or
  -- top-level non-event post, owned by another account. The row is the
  -- reposter's.
  (SELECT 'repost', r.uri, r.cid, r.did, r.record_created_at, r.json->'subject'->>'uri', NULL, true
   FROM record AS r, params AS p
   WHERE 'repost' = ANY($1::text[])
     AND r.collection = 'app.gainforest.feed.repost'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND (r.record_created_at, r.uri) < (p.cursor_ts, p.cursor_uri)
     AND r.validation_status = 'valid'
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
  (SELECT 'audio', head.uri, head.cid, head.owner, head.ts, NULL, head.folder, false
   FROM audio_heads AS head
   ORDER BY head.ts DESC, head.uri DESC
   LIMIT $6::integer)
  UNION ALL
  -- An observation with a valid bioacoustic sidecar is shown on its own, with
  -- its spectrogram, so it never joins a burst.
  (SELECT 'observation', r.uri, r.cid, r.did, r.record_created_at, NULL, NULL,
          NOT COALESCE(
            sidecar.segment IS NOT NULL
            AND jsonb_typeof(sidecar.segment) = 'object'
            AND sidecar.segment->'version' = '1'::jsonb
            AND jsonb_typeof(sidecar.segment->'sourceAudioUri') = 'string'
            AND sidecar.segment->>'labelCategory' IN ('bird', 'frog', 'insect', 'other', 'note')
            AND jsonb_typeof(sidecar.segment->'startTimeSeconds') = 'number'
            AND jsonb_typeof(sidecar.segment->'endTimeSeconds') = 'number'
            AND jsonb_typeof(sidecar.segment->'minFrequencyHz') = 'number'
            AND jsonb_typeof(sidecar.segment->'maxFrequencyHz') = 'number'
            AND sidecar.segment->>'sourceAudioUri' = ANY(
              ARRAY(SELECT btrim(media) FROM unnest(string_to_array(r.json->>'associatedMedia', '|')) AS media)
            ),
            false
          )
   FROM record AS r
   CROSS JOIN params AS p
   CROSS JOIN LATERAL (
     SELECT CASE
       WHEN jsonb_typeof(r.json->'dynamicProperties') = 'string'
        AND r.json->>'dynamicProperties' LIKE '%gainforestBioacoustics%'
        AND pg_input_is_valid(r.json->>'dynamicProperties', 'jsonb')
         THEN (r.json->>'dynamicProperties')::jsonb->'gainforestBioacoustics'
     END AS segment
   ) AS sidecar
   WHERE 'observation' = ANY($1::text[])
     AND r.collection = 'app.gainforest.dwc.occurrence'
     AND r.record_created_at IS NOT NULL
     AND r.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
     AND (r.record_created_at, r.uri) < (p.cursor_ts, p.cursor_uri)
     AND r.validation_status = 'valid'
     AND (NOT $2::boolean OR r.did IN (SELECT did FROM follows))
   ORDER BY r.record_created_at DESC, r.uri DESC
   LIMIT $7::integer)
),
-- The merged feed order, cut at $7 rows.
stream AS (
  SELECT * FROM branches ORDER BY ts DESC, uri DESC LIMIT $7::integer
),
-- A row continues the previous row's burst when both are burstable
-- observations by the same account, adjacent in this merged order, and no
-- more than $8 seconds apart. Any other row, including another kind or another
-- account's observation, starts a new item.
flagged AS (
  SELECT s.*,
         COALESCE(
           s.kind = 'observation' AND s.burstable
           AND lag(s.kind) OVER feed_order = 'observation'
           AND lag(s.burstable) OVER feed_order
           AND lag(s.did) OVER feed_order = s.did
           AND lag(s.ts) OVER feed_order - s.ts <= make_interval(secs => $8::integer),
           false
         ) AS continues_run
  FROM stream AS s
  WINDOW feed_order AS (ORDER BY s.ts DESC, s.uri DESC)
),
-- Item number: how many items have started at or before this row.
numbered AS (
  SELECT f.*, sum((NOT f.continues_run)::integer) OVER (ORDER BY f.ts DESC, f.uri DESC) AS item_no
  FROM flagged AS f
),
runs AS (
  SELECT n.item_no,
         count(*)::integer AS row_count,
         (array_agg(n.ts ORDER BY n.ts ASC, n.uri ASC))[1] AS oldest_ts,
         (array_agg(n.uri ORDER BY n.ts ASC, n.uri ASC))[1] AS oldest_uri,
         (array_agg(n.uri ORDER BY n.ts DESC, n.uri DESC))[1:$9::integer] AS samples
  FROM numbered AS n
  WHERE n.item_no <= $6::integer
  GROUP BY n.item_no
),
items AS (
  SELECT n.item_no, n.kind, n.uri, n.cid, n.did, n.ts, n.subject, n.deployment,
         run.row_count, run.oldest_ts, run.oldest_uri, run.samples
  FROM numbered AS n
  JOIN runs AS run ON run.item_no = n.item_no
  WHERE NOT n.continues_run
),
-- The audio group behind each audio head: every recording of that owner and
-- folder on that UTC day, whoever stored it.
audio_groups AS (
  SELECT item.item_no, audio_group.total, audio_group.samples
  FROM items AS item
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS total,
           (array_agg(member.uri ORDER BY member.record_created_at DESC, member.uri DESC))[1:$9::integer] AS samples
    FROM record AS member
    CROSS JOIN LATERAL (
      SELECT CASE WHEN member.json->>'deploymentRef' LIKE 'at://%' THEN member.json->>'deploymentRef' END AS folder,
             CASE WHEN member.json->>'deploymentRef' LIKE 'at://did:%'
                  THEN substring(member.json->>'deploymentRef' from '^at://([^/]+)')
                  ELSE member.did
             END AS owner
    ) AS audio_key
    WHERE member.collection = 'app.gainforest.ac.audio'
      AND member.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'
      AND member.record_created_at >= date_trunc('day', item.ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      AND member.record_created_at < (date_trunc('day', item.ts AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'
      AND member.validation_status = 'valid'
      AND audio_key.owner = item.did
      AND audio_key.folder IS NOT DISTINCT FROM item.deployment
  ) AS audio_group
  WHERE item.kind = 'audio' AND item.item_no < $6::integer
),
-- The page is exact when both of these hold:
--  * the item after it was found, or nothing was cut off the merged order; and
--  * the audio groups are known as far down as the page reaches. The audio
--    scan sees every recording down to its horizon, the oldest recording it
--    read. Below that, groups can be missing unless the scan already found as
--    many as a page can use.
completeness AS (
  SELECT (
           (SELECT count(*) FROM audio_heads) >= $6::integer
           OR NOT EXISTS (SELECT 1 FROM audio_horizon)
           OR EXISTS (
             SELECT 1
             FROM items AS sentinel, audio_horizon AS horizon
             WHERE sentinel.item_no = $6::integer
               AND (sentinel.ts, sentinel.uri) >= (horizon.ts, horizon.uri)
           )
         )
         AND (
           (SELECT count(*) FROM items) >= $6::integer
           OR (SELECT count(*) FROM stream) < $7::integer
         ) AS complete
)
SELECT completeness.complete,
       item.item_no::integer AS item_no,
       item.kind,
       item.uri,
       -- Hyperindex stores an empty CID for records whose event carried none.
       NULLIF(item.cid, '') AS cid,
       item.did,
       to_char(item.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_value,
       item.subject,
       item.deployment,
       to_char(item.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
       (CASE WHEN item.kind = 'audio' THEN audio_group.total ELSE item.row_count END)::integer AS total,
       to_char(item.oldest_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS tail_sort_value,
       item.oldest_uri AS tail_uri,
       CASE WHEN item.kind = 'audio' THEN audio_group.samples ELSE item.samples END AS samples
FROM completeness
LEFT JOIN items AS item ON true
LEFT JOIN audio_groups AS audio_group ON audio_group.item_no = item.item_no
ORDER BY item.item_no
