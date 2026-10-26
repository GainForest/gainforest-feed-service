# Database contract

The feed service reads Hyperindex's current PostgreSQL state directly. Hyperindex owns the tables, migrations, indexes, and ingestion. This document describes the schema and current-state semantics the service consumes. It does not make this service an ingestion owner, and nothing in this repository changes Hyperindex or its database.

## Readiness and compatibility

`/ready` checks that PostgreSQL is reachable, is version 16 or newer, supports `pg_input_is_valid` for `jsonb`, runs the session read-only, and that the feed's role can read the `record` columns the feed statement uses (`uri`, `cid`, `did`, `collection`, `json`, `record_created_at`, `validation_status`). A missing table, a missing column, or a missing `SELECT` grant produces a not-ready response that names the problem. It does not check migration history, indexes, ingestion freshness, or whether the collections the feed reads are being stored.

PostgreSQL 16 or newer is required because the feed statement uses `pg_input_is_valid` to parse the JSON text that bioacoustic sightings carry in `dynamicProperties`.

## Runtime schema

The service reads one Hyperindex table, `public.record`:

```text
record.uri                 text, primary key
record.cid                 text
record.did                 text
record.collection          text
record.json                jsonb (the record)
record.indexed_at          timestamptz, not used by the feed
record.record_created_at   timestamptz, nullable   (migration 010)
record.validation_status   text, not null          (migration 012)
```

The canonical migrations are the files in `internal/database/migrations/postgres` in the Hyperindex repository (001 through 014 on `main` at the time of writing). The older `db/migrations_postgres` directory stops at migration 004 and is not what Hyperindex applies. The service needs exactly two of them: **migration 010** for `record_created_at` and its timeline indexes, and **migration 012** for `validation_status`. Its queries also rely on `idx_record_did_collection` from migration 001. Later migrations are not required.

The service does not read `actor`, `label`, or any other Hyperindex table, and it does not read handles.

## Read-only access

Use a dedicated role with `SELECT` on `record` only. `default_transaction_read_only=on` is defense in depth, not a replacement for grants.

```sql
CREATE ROLE gainforest_feed_reader LOGIN PASSWORD '<managed-secret>';
GRANT CONNECT ON DATABASE hyperindex TO gainforest_feed_reader;
GRANT USAGE ON SCHEMA public TO gainforest_feed_reader;
GRANT SELECT ON TABLE public.record TO gainforest_feed_reader;
ALTER ROLE gainforest_feed_reader SET default_transaction_read_only = on;
```

Before configuring `DATABASE_URL`, verify with that login that it can connect, `SELECT` from `record`, and reports a read-only session. Keep the database private to the service network.

## What the feed selects

Every selected row must satisfy all of these:

- `validation_status = 'valid'`. Hyperindex's typed GraphQL collections (the ones GainForest hydrates through) return only valid records, so the feed never returns a reference that hydration cannot resolve.
- `record_created_at IS NOT NULL`. Hyperindex fills this column from the record's top-level `createdAt` when it is a valid RFC3339 datetime and leaves it NULL otherwise. Records with a missing or malformed `createdAt` are excluded.
- `record_created_at` between 1970-01-01 and five minutes from now. See dates.

Hyperindex's ingestion accepts events that carry no CID (`internal/database/repositories/records.go`: "If cid == \"\" (omitted by Tap for some events)"), so `record.cid` can be an empty string. The feed omits the `cid` field of those items instead of failing the page.

The kinds, by collection:

| Item                                     | Collection                         | Extra rules                                                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordItem` `project`                   | `org.hypercerts.collection`        | `json->>'type'` is `project` or `Project`                                                                                                                                                                           |
| `recordItem` `organization`              | `app.certified.actor.organization` | None. The app still filters organizations with its private ledger.                                                                                                                                                  |
| `recordItem` `post`                      | `app.gainforest.feed.post`         | No `reply`, and no `community-event` tag                                                                                                                                                                            |
| `recordItem` `observation` / `burstItem` | `app.gainforest.dwc.occurrence`    | None. See bursts and chunks.                                                                                                                                                                                        |
| `repostItem`                             | `app.gainforest.feed.repost`       | Only in the `all` filter. The subject must exist, be valid, and be owned by another account, as an observation, a project typed `project` or `Project`, or a top-level post (no `reply`, no `community-event` tag). |
| `audioItem`                              | `app.gainforest.ac.audio`          | Runs of adjacent recordings, see audio runs.                                                                                                                                                                        |

Donations (`org.hypercerts.funding.receipt`) and every other collection are never selected.

### Following

With `following: true`, rows are limited to accounts the viewer follows: the distinct `json->>'subject'` of the viewer's valid `app.certified.graph.follow` records (`did = viewer`). Posts, projects, observations, and organizations are scoped by the record owner. Reposts are scoped by the reposter. Audio runs are scoped by the run's owner, which is the folder's owner when the recordings name a folder, not necessarily the account that stored the recording. A viewer who follows nobody gets an empty page, and the statement answers it without reading a feed collection: every arm begins with `NOT following OR EXISTS (follows)`, which PostgreSQL evaluates once as a one-time filter, so none of the six arms runs. Without that guard each arm walked its whole collection looking for rows that nothing could pass (about 100 ms on the evidence data below, 1.4 to 1.8 s on a table ten times as large).

### Order and cursor

Feed order is:

```text
record_created_at DESC, uri DESC
```

`record_created_at` has millisecond precision and Hyperindex never overwrites a non-null value on update. Ties break by `uri`, compared with the database collation. Cursor version 2 is unpadded base64url JSON containing exactly `{ version: 2, feedId, value: { value, uri, group? } }`. It is scoped to the selected feed. `value` and `uri` are the position of the last row the previous page consumed, and the next page selects rows strictly after it. A chunk consumes all of its rows, so the cursor points at the chunk's oldest row and the next page begins with the first row after it. `group` is exactly `{ key, kind }` (`kind` is `observation` or `audio`). It is present only when the page's last chunk was cut at the 200-row cap and the run goes on, and it names that run so the next page can continue it. It carries nothing a record controls: the statement reads the run's account and folder from the cursor row in the database (see chunks), so a cursor cannot outgrow the 4,096 characters the response allows, whatever a record stores. The cursor is an unsigned token held by the client, so the service trusts it only to position that client's own page. A `value` that is a valid RFC 3339 datetime but that PostgreSQL cannot cast, namely a day the month does not have (`2026-02-30`), year 0000, or a UTC offset beyond ±15:59, is rejected as `InvalidCursor` when the cursor is decoded. Version 1 cursors are rejected with `InvalidCursor`. Pagination is deterministic for each query but is not a snapshot across requests.

### Dates

`createdAt` is client-declared, so the feed reads only rows with `record_created_at` from 1970-01-01T00:00:00Z up to five minutes after the statement's `now()`. Hyperindex accepts any datetime Indigo parses, so a valid record dated `9999-12-31T23:59:59-05:00` is stored as year 10000, which PostgreSQL accepts but which is not a valid datetime on the wire; one such row would fail every page that includes its kind. A record dated far in the future would otherwise stay at the top of the feed forever. Rows outside the range are ignored until their time arrives. Every read of `record` in the statement applies the same range, written out as literals so the planner can still walk the timeline index in order.

### Bursts and audio runs

Rows that are adjacent in the merged feed order form one run when they have the same kind and key and no more than 12 hours separate neighbours (a gap of exactly 12 hours joins them). A row of any other kind, or with another key, ends the run.

- **Bursts** are observations keyed by account (`did`). A bioacoustic sighting never joins a burst: an observation whose `dynamicProperties` text parses to a `gainforestBioacoustics` sidecar with version 1, a source audio URI that appears in `associatedMedia`, a known label category, and numeric time and frequency bounds. Those sightings are shown on their own. A run of one observation stays a `recordItem`. The minimum run length is 2, which is `MIN_BATCH` 3 in the GainForest app's current client-side grouping, so the app should expect two-observation bursts.
- **Audio runs** are recordings keyed by owner and folder. A recording whose `deploymentRef` is an AT-URI belongs to that recorder folder, and the folder's owner, the account in the AT-URI, owns the run whoever stored the recording. A recording without a folder belongs to its own account. If the authority of the AT-URI is not a valid DID, because it is a handle or anything else, the recording also falls back to its own account, because `audioItem.did` must be a DID. A valid DID here is the shape the Lexicon's `did` format accepts: `did:method:id`, a lowercase method, the characters `A-Z a-z 0-9 . _ : % -`, no trailing `:` or `%`, at most 2,048 characters. The item names the folder in `audioItem.deployment` only when `deploymentRef` is a valid AT-URI, by the strict `isAtUriString` test, which is also what the output check of `format: at-uri` applies. For any other value (`at://did:/x`, a trailing slash, a query, a path that is not a collection and a key) `deployment` is omitted and the recordings still group by the raw `deploymentRef`, with the owner rule above. One malformed `deploymentRef` therefore cannot fail the page that holds it; before, it answered 500 on every `getFeed` page with that recording. A single recording is an `audioItem` with a total of 1. The service no longer groups by upload day: an exact day group needed the whole day, and one recorder's 1,700 files made the statement read the same recordings again and again. Two recorders uploading into different folders at the same time interrupt each other, so interleaved uploads make many short items. The app also looks the folder up and falls back to the recording's account when the folder record is missing; the service reads the owner from the AT-URI and does not look the folder up.

"Adjacent" follows the active filter. With the `observation` filter only observations are in the order, so another account's observation still ends a burst, but a post does not. With the `audio` filter only recordings are.

### Chunks

One item covers at most 200 rows (`MAX_GROUP_ROWS`). A longer run is cut into chunks of 200 rows, newest first, counted from the run's first row:

- every chunk after the first has `continued`;
- a chunk that is full and followed by another row of the same run is `capped`: a run of exactly 200 rows is one uncapped chunk, and a run of 201 is a chunk of 200 (`capped`) and a chunk of 1 (`continued`);
- every chunk of one run carries the same opaque `groupKey`, derived from the run's newest record, and no two runs share one. It is stable only within one paging walk: it changes when a newer record joins the run, so clients must not keep it as a long-lived identity across refreshes;
- an item's `total`, `from`, `to`, and up to 20 sample URIs describe that chunk only.

A page ends only at a chunk boundary, so the next page starts a new chunk. When the page's last chunk is `capped`, the cursor names its run (`group` in the cursor: the `groupKey` and the kind), and the next page marks its first item `continued`, with the same `groupKey`, if the first row after the cursor still joins that run: same kind, same key, and no more than 12 hours after the cursor's row. The statement applies the same adjacency predicate to that row as to every other row. The cursor row's key (its account, and its folder for audio) is not in the cursor. The statement reads the row by primary key and derives the key with the same expressions the arms use. The run continues only while that row still exists, is valid and in range, is of the named kind, and still has the timestamp the cursor carries. Otherwise the first item starts a new run.

Results are current state, so `capped` does not guarantee that the next page starts `continued`: a write between two requests, such as the cursor row being deleted, can break the continuation. `continued` is the authority, and a client merges only on it.

### Reads per page

One statement answers a page. It may read at most `limit × 200 + 1` rows of the merged feed order: the page's items cover at most `limit × 200` rows, and one more row, the first row of the item after the page, proves that a next page exists and tells whether the last chunk is `capped`. The row that follows an item is the first row of the next item, so no item needs a lookahead of its own. This is an upper bound. The statement streams the merged order and stops at the first row of the item after the sentinel item (the item that only proves that a next page exists), so it reads up to the end of the sentinel chunk, which is at most 200 rows more than the page's own items. An ordinary page reads a few hundred rows (892 for a first page of 20 items on the evidence data below) and only a page made of full chunks reads the whole bound. A page that continues a capped run adds one primary-key read of the cursor row. There is no wider second window, no incomplete page, and no error for a long run. A statement that exceeds the statement timeout is a database problem and surfaces as `InternalError`.

## Hyperindex behavior the feed depends on

**Validation status and revalidation.** Migration 012 adds `validation_status` with the default `'unknown_schema'`. Rows that predate the migration, and rows of a collection that has no saved lexicon, stay `unknown_schema` until Hyperindex validates them (its startup validation refresh reads `record` by `(collection, uri)`; see migration 014). The feed selects only `valid` rows, so a table that has not been revalidated gives an empty or partial feed, while `/ready` stays green: readiness checks that the columns and the grant exist, not what the rows contain. Before cutover, confirm that the collections the feed reads are validated, for example with a read-only login:

```sql
SELECT collection, validation_status, count(*)
FROM record
WHERE collection IN (
  'org.hypercerts.collection', 'app.certified.actor.organization',
  'app.gainforest.feed.post', 'app.gainforest.feed.repost',
  'app.gainforest.dwc.occurrence', 'app.gainforest.ac.audio',
  'app.certified.graph.follow'
)
GROUP BY 1, 2
ORDER BY 1, 2;
```

Most rows of each collection should be `valid`. The service deliberately has no readiness query for this.

**`record_created_at` is not the GraphQL sort key.** Hyperindex fills `record_created_at` with the first valid `createdAt` it sees, truncated to milliseconds, and never overwrites a non-null value on update (`COALESCE(record.record_created_at, EXCLUDED.record_created_at)`). Its typed GraphQL `sortBy: createdAt` sorts on the JSON `createdAt` text instead. The two orders agree for normalized `Z` timestamps. They can differ for `createdAt` strings written with an offset or with different fractional precision, and for records whose JSON `createdAt` was edited after the first ingest. The service orders by `record_created_at`, and the app hydrates by URI, so the service order decides the feed.

## Indexes

Hyperindex owns indexes. The service creates none and needs none beyond those Hyperindex already has.

Used today, all from existing migrations:

```text
idx_record_timeline_collection_created
  ON record (collection, record_created_at DESC, uri DESC)
  WHERE record_created_at IS NOT NULL                          -- migration 010
idx_record_did_collection ON record (did, collection)          -- migration 001
record_pkey ON record (uri)                                    -- repost subject lookups
```

The per-kind arms walk `idx_record_timeline_collection_created`, in index order and only as far as the merged page needs. Follow lookups use `idx_record_did_collection`. The record behind each of the page's own items, the subject of each repost, and the few observations whose text mentions a bioacoustic sidecar are read by primary key. The `scripts/test-hyperindex-schema.sh` preflight checks that the first two exist.

### Proposal for the Hyperindex owners

This is a proposal, not a change this repository applies. Measure it on production-shaped data first, build it concurrently, and decide whether the gain is worth the write cost.

```sql
CREATE INDEX CONCURRENTLY idx_record_feed_post_toplevel
  ON record (record_created_at DESC, uri DESC)
  WHERE collection = 'app.gainforest.feed.post'
    AND validation_status = 'valid'
    AND record_created_at IS NOT NULL
    AND (json->>'reply') IS NULL;
```

PostgreSQL estimates that the post filters match very few rows (about 8). With the current statement it still walks the timeline index for posts on the evidence data below, and a post-only page of 50 takes about 3 ms, so the index is not needed there. Build it only if the plan of the post arm on the production-shaped table shows a Bitmap Heap Scan and a sort: that was the plan of the previous statement and cost about 40 ms of every request that included posts.

### Evidence from scratch databases

These numbers come from a throwaway local PostgreSQL 16.15 cluster with the real Hyperindex migrations 001 through 014 applied and synthetic data shaped like the staging table when pages started failing. They are warm-cache runs of the feed statement under `EXPLAIN (ANALYZE, BUFFERS)` with JIT off, not a benchmark, and planning adds about 5 ms. The figures for the statement before this change were measured earlier on the same data shape. The table had 172,095 rows: 39,362 observations (16,044 of them invalid), 63,107 audio recordings (two recorders with 1,700 and 1,400 recordings in the newest day, uploaded one after the other), 4,025 posts, 1,900 collections (about 760 typed project), 101 organizations, 600 reposts, 3,000 follows, and 60,000 rows of collections the feed ignores. Every statement ran twice, on the load-ordered heap and on a copy in random physical order, which is the harder case for an ordered index scan. The ranges below cover both.

The statement before this change, first page of 20 items, needed two statements:

```text
scan window 512 (page incomplete)        49-73 ms
scan window 8,192 (the second statement) 509-608 ms   Bitmap Heap Scan over all 63,107 audio and all 39,362
                                                      observation rows, external-merge sorts of 15.8 MB and
                                                      5.2 MB, and the full json carried through the sort
```

The current statement, one statement per page (medians of five runs, JIT off):

```text
all kinds, limit 20, first page                       10-11 ms   892 rows read of 4,001
all kinds, limit 50, first page                       20-21 ms   1,805 rows read of 10,001
audio only, limit 20 / 50                             18-19 ms / 17-20 ms
observations only, limit 20 / 50                      3 ms / 3-4 ms
following (20 follows), all kinds, limit 20 / 50      13-17 ms / 20-26 ms
following nobody, limit 20 / 50                       0.8-1.0 ms / 0.8 ms   (about 99 ms without the guard)
all kinds, limit 50, cursor 30 / 90 / 200 days back   7 / 5 / 7-9 ms
walk of a capped audio run, limit 4, every page       1-9 ms   (the open run is read by primary key)
worst case, 12,000-row runs, every row of the bound is read
  audio, limit 20 / 50                                37 / 93 ms    4,001 / 10,001 rows
  observations, limit 20 / 50                         29 / 72 ms    4,001 / 10,001 rows
```

Telling a recording's owner apart from a bad authority costs about 0.8 microseconds per audio row the statement reads (a regular expression on the authority). That is about 1 to 2 ms of the audio and all-kinds pages above, and up to 5 ms for a viewer with few follows, whose scan reads thousands of recordings to find a few.

No plan used a bitmap scan on a feed collection, a sequential scan, or a sort that left memory (the largest sort was 1.5 MB). The follow lookup reads the viewer's follow records with a bitmap scan on `idx_record_did_collection`, which is not a feed collection. The estimated cost stayed near 12,000, far below PostgreSQL's default `jit_above_cost` of 100,000, so JIT did not start.

What keeps the plan this way is listed in the header of `src/feed/feed-query.sql`. In short: the observation and audio arms and the merged stream take their limit from a subquery, because a literal limit above about a third of a collection makes PostgreSQL switch to a bitmap scan and a sort of the whole collection; the cursor is an inline predicate so a deep page is an index condition; the window levels stream and `item_no` is a `count(*) FILTER` so the window stops early; and no record content is read before it is known to matter.

Known follow-ups, deliberately not built:

- A viewer who follows few accounts, with little audio or observation history, still makes the audio and observation arms walk their collections: each reads the timeline index newest first and filters by owner as it goes, so with few matching rows it reaches the end of the collection before the bound helps. The guard above fixes the extreme case of a viewer who follows nobody, and a viewer with 20 active follows takes 13 to 26 ms. A viewer with a few follows who have posted no audio or observations took 1.5 to 1.6 s on a table ten times the evidence data (measured when this branch was reviewed). The real fix is one more arm per kind that is driven by the followed accounts, reading `idx_record_timeline_author_collection_created` (`did, collection, record_created_at DESC, uri DESC`) for each followed account and merging the results. Audio cannot use that index directly, because its owner is the folder's owner from `deploymentRef`, not the account in `did`; an audio arm would have to find the folders the followed accounts own as well as their own recordings. It is not built.
- Interleaved uploads fragment runs. Adjacent recordings must share an owner and a folder, so two recorders uploading at the same time, or one account mixing observations and recordings, produce many one- and two-row items where the old upload-day groups produced one. This is the intended rule; it is a product question whether to relax it.
- A long observation run costs about 9 us per row on the evidence data (88 ms for 10,001 rows), partly because every observation of the run gets a text test for a bioacoustic sidecar, with a primary-key read only for the rare match. A partial index on the observations whose `dynamicProperties` mention `gainforestBioacoustics` could make that test cheaper. It has not been measured and is not proposed.
- The estimated cost of the statement grows with the number of rows in the collections, because PostgreSQL plans for the first tenth of the rows: about 12,000 on the evidence data and about 95,000 on a table ten times as large (measured when this branch was reviewed), close to the default `jit_above_cost` of 100,000. Above it JIT compilation would add 100 to 150 ms to every page, and it cannot help a statement that runs in 10 ms. The pool therefore opens every session with `-c jit=off` (`src/database.ts`). Nothing needs to be configured on the database.

## Schema preflight and integration tests

The behavior suite runs on an explicitly chosen, empty, disposable PostgreSQL 16+ database. It creates `public.record` with the Hyperindex columns and indexes above when the database has none, copies it into a private schema for each test, and drops that schema afterwards. It does not drop or truncate `public.record`. Never target a shared, staging, or production database.

To check a database that Hyperindex has migrated before running the same suite:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/hyperindex_feed_test' \
  npm run test:integration:hyperindex
```

The command requires `psql`, checks PostgreSQL 16+, the `record` columns, and the two indexes above (`idx_record_timeline_collection_created` and `idx_record_did_collection`), then runs `npm run test:integration`. It does not apply migrations. The suite's direct SQL fixture loading does not exercise Hyperindex's ingestion path or its `record_created_at` materialization.
