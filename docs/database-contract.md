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

The canonical migrations are the files in `internal/database/migrations/postgres` in the Hyperindex repository (001 through 015 at the time of writing). The older `db/migrations_postgres` directory stops at migration 004 and is not what Hyperindex applies. The service needs exactly two of them: **migration 010** for `record_created_at` and its timeline indexes, and **migration 012** for `validation_status`. Its queries also rely on `idx_record_did_collection` from migration 001. Later migrations are not required.

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
| `recordItem` `observation` / `burstItem` | `app.gainforest.dwc.occurrence`    | None. See bursts.                                                                                                                                                                                                   |
| `repostItem`                             | `app.gainforest.feed.repost`       | Only in the `all` filter. The subject must exist, be valid, and be owned by another account, as an observation, a project typed `project` or `Project`, or a top-level post (no `reply`, no `community-event` tag). |
| `audioItem`                              | `app.gainforest.ac.audio`          | Grouped, see audio groups.                                                                                                                                                                                          |

Donations (`org.hypercerts.funding.receipt`) and every other collection are never selected.

### Following

With `following: true`, rows are limited to accounts the viewer follows: the distinct `json->>'subject'` of the viewer's valid `app.certified.graph.follow` records (`did = viewer`). Posts, projects, observations, and organizations are scoped by the record owner. Reposts are scoped by the reposter. Audio groups are scoped by the group's owner, which is the folder's owner when the recordings name a folder, not necessarily the account that stored the recording. A viewer who follows nobody gets an empty page.

### Order and cursor

Feed order is:

```text
record_created_at DESC, uri DESC
```

`record_created_at` has millisecond precision and Hyperindex never overwrites a non-null value on update. Ties break by `uri`, compared with the database collation. Cursor version 1 is unpadded base64url JSON containing exactly `{ version: 1, feedId, value: { value, uri } }`. It is scoped to the selected feed. `value` and `uri` are the position of the last row the previous page consumed, and the next page selects rows strictly after it. A burst consumes all of its members, so the cursor points at the burst's oldest member and the next page begins with the first row after the burst. Pagination is deterministic for each query but is not a snapshot across requests.

### Dates

`createdAt` is client-declared, so the feed reads only rows with `record_created_at` from 1970-01-01T00:00:00Z up to five minutes after the statement's `now()`. Hyperindex accepts any datetime Indigo parses, so a valid record dated `9999-12-31T23:59:59-05:00` is stored as year 10000, which PostgreSQL accepts but which is not a valid datetime on the wire; one such row would fail every page that includes its kind. A record dated far in the future would otherwise stay at the top of the feed forever. Rows outside the range are ignored until their time arrives. Every read of `record` in the statement, including audio group totals and the check for emitted groups, applies the same range, written out as literals so the planner can still walk the timeline index in order.

### Bursts

Observations by one account that are adjacent in the merged feed order collapse into one `burstItem` when:

- they are by the same `did`;
- no more than 12 hours separate neighbours (a gap of exactly 12 hours joins them);
- no other selected row lies between them. A row of another kind, or another account's observation, ends the run;
- neither neighbour is a bioacoustic sighting: an observation whose `dynamicProperties` text parses to a `gainforestBioacoustics` sidecar with version 1, a source audio URI that appears in `associatedMedia`, a known label category, and numeric time and frequency bounds. Those sightings are shown on their own.

A run of one observation stays a `recordItem`. A burst carries its exact member count, the oldest and newest `createdAt`, and up to 20 sample URIs, newest first. The minimum run length is 2, which is `MIN_BATCH` 3 in the GainForest app's current client-side grouping, so the app should expect two-observation bursts.

"Adjacent" follows the active filter. With the `observation` filter only observations are in the order, so another account's observation still ends a run, but a post does not.

### Audio groups

Audio groups follow the GainForest app's upload days. A recording whose `deploymentRef` is an AT-URI belongs to that recorder folder, and the folder's owner, the account in the AT-URI, owns the group whoever stored the recording. A recording without a folder belongs to its own account. If the AT-URI names a handle instead of a DID, the recording also falls back to its own account, because `audioItem.did` must be a DID. A group is one owner, one folder (or none), and one UTC calendar day of `record_created_at`. So two accounts uploading into one folder on one day make one group, and `audioItem.did` is the owner. Only the newest recording of a group takes part in the feed order, so an older recording of an emitted group never reappears on a later page. The group's `total` and sample URIs come from every valid recording in that group, whatever the cursor and whichever repo stores it.

One deliberate difference from the app: it takes the day from the first ten characters of the `createdAt` string, while the service takes the UTC day of `record_created_at`. They agree for timestamps written in UTC (ending in `Z`), and differ for timestamps written with an offset. For a folder whose AT-URI names a handle instead of a DID, the app merges recordings from different repos into one group, while the service keeps one group per recording account. The app also looks the folder up and falls back to the recording's account when the folder record is missing; the service reads the owner from the AT-URI and does not look the folder up.

### Scan window

The statement reads at most `scan_rows` rows of the merged feed order, starting at 512, and reports `complete = false` when a page needs more: an observation run, or a run of recordings, longer than the window, or audio groups that the page reaches but the audio scan has not seen. The service repeats the statement with 8,192, then 131,072, then 2,097,152 rows, and fails the request rather than return a page that could split a burst or lose a group. The failure is the typed error `ScanLimitExceeded` (HTTP 422): it depends on the data, not on the request, so a retry fails the same way. A statement timeout (SQLSTATE 57014) on any window after the first maps to the same error, because it means the run is too long to group in time; with the default 5-second `DATABASE_STATEMENT_TIMEOUT_MS` this is how a very long run usually ends, since the widest statements are the slow ones. A timeout on the first, 512-row window stays a generic `InternalError`: that is a database outage, not a long run. Most pages finish in one statement. The statement count is not part of the public contract.

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

The per-kind branches walk `idx_record_timeline_collection_created`. Audio group totals and the check for emitted groups read one UTC day of that index. Follow lookups use `idx_record_did_collection`. The `scripts/test-hyperindex-schema.sh` preflight checks that the first two exist.

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

Without it, PostgreSQL treats the post filters as very selective, estimates about 21 matching rows, and reads every post through a bitmap scan before a top-N sort. On the local test data below that costs about 40 ms of every request that includes posts.

### Evidence from scratch databases

These numbers come from throwaway local PostgreSQL 16.15 clusters with the real Hyperindex migrations 001 through 015 applied and synthetic data shaped like the GainForest feed. They are single warm-cache runs of the feed statement, not a benchmark, and planning adds about 3 ms per statement.

Before fix round 1, on 283,394 `record` rows (66,168 observations including sessions of up to 2,500, 46,996 audio recordings including three single-day dumps of 3,000, 8,000 posts, 3,000 organizations, 2,000 reposts, 700 projects), which is where the proposal above was measured:

```text
all kinds, limit 20, first page                 ~58 ms   1 statement
all kinds, limit 20, first page, post index     ~20 ms   1 statement  (with the proposal above)
```

After fix round 1, with the final statement (date range guard, audio groups by folder owner), on about 76,000 rows: 43,000 observations including one burst of 3,000, 29,000 audio recordings (three single-day dumps of 3,000, each in one folder, and 20,000 spread over 200 days), 3,000 posts, 1,000 reposts, 300 projects, and a viewer following 50 accounts:

```text
all kinds, limit 20, first page                 ~20 ms   1 statement
all kinds, limit 50, first page                ~250 ms   2 statements (reaches a 3,000-recording day)
observations only                                ~9 ms   1 statement
audio only                                      ~10 ms   1 statement
following (50 follows), all kinds               ~42 ms   1 statement
all kinds, page 6 months back                   ~50 ms   1 statement
```

The first-page audio case once took about 1.7 s, because the statement retried until the audio scan found enough groups even when the page never reached them. It now retries only when the page reaches below the oldest recording the audio scan read. Known follow-ups, deliberately not built yet:

- A page that reaches a large audio day or a long burst pays for a second statement that rescans every branch at the larger window. At 8,192 rows PostgreSQL stops using the ordered index scan for observations and switches to a bitmap scan and sort (about 140 ms for that branch alone). Growing the audio window separately from the observation window, or using smaller steps between windows, would avoid most of it.
- Audio groups come from reading recordings one by one, so one large day dominates the cost of any page that reaches it. Group totals read a whole UTC day of the collection index and filter by owner and folder, because recordings of one folder can be stored in any repo. Counting by group, for example with a loose index scan, would avoid that.
- A run of observations or recordings longer than 2,097,152 rows cannot be paged and fails with `ScanLimitExceeded`. Capping the run length is a product decision that is still open.
- The post filters are the proposal above.

## Schema preflight and integration tests

The behavior suite runs on an explicitly chosen, empty, disposable PostgreSQL 16+ database. It creates `public.record` with the Hyperindex columns and indexes above when the database has none, copies it into a private schema for each test, and drops that schema afterwards. It does not drop or truncate `public.record`. Never target a shared, staging, or production database.

To check a database that Hyperindex has migrated before running the same suite:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/hyperindex_feed_test' \
  npm run test:integration:hyperindex
```

The command requires `psql`, checks PostgreSQL 16+, the `record` columns, and the two indexes above (`idx_record_timeline_collection_created` and `idx_record_did_collection`), then runs `npm run test:integration`. It does not apply migrations. The suite's direct SQL fixture loading does not exercise Hyperindex's ingestion path or its `record_created_at` materialization.
