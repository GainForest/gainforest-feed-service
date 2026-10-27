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

The canonical migrations are the files in `internal/database/migrations/postgres` in the Hyperindex repository (001 through 014 on `main` at the time of writing). The older `db/migrations_postgres` directory stops at migration 004 and is not what Hyperindex applies. The service needs exactly two of them: **migration 010** for `record_created_at` and its timeline indexes, and **migration 012** for `validation_status`. Later migrations are not required.

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

| Item                                       | Collection                         | Extra rules                                                                                                                                                                                                         |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordItem` `project`                     | `org.hypercerts.collection`        | `json->>'type'` is `project` or `Project`                                                                                                                                                                           |
| `recordItem` `organization`                | `app.certified.actor.organization` | None. The app still filters organizations with its private ledger.                                                                                                                                                  |
| `recordItem` `post`                        | `app.gainforest.feed.post`         | No `reply`, and no `community-event` tag                                                                                                                                                                            |
| `recordItem` `observation`, or `groupItem` | `app.gainforest.dwc.occurrence`    | None. Observations of one account fold into groups, see groups.                                                                                                                                                     |
| `repostItem`                               | `app.gainforest.feed.repost`       | Only in the `all` filter. The subject must exist, be valid, and be owned by another account, as an observation, a project typed `project` or `Project`, or a top-level post (no `reply`, no `community-event` tag). |
| `recordItem` `audio`, or `groupItem`       | `app.gainforest.ac.audio`          | Recordings of one owner and folder fold into groups, see groups.                                                                                                                                                    |

Donations (`org.hypercerts.funding.receipt`) and every other collection are never selected.

**Selection does not depend on the caller.** The statement takes the active kinds, the cursor position, and the batch size, and nothing that identifies who asks: no viewer, no follow records, no owner scope. Every caller gets the same rows for the same request, with or without a service-auth token. Following is planned as a separate feed (see the follow-ups below).

### Order and cursor

Feed order is:

```text
record_created_at DESC, uri DESC
```

`record_created_at` has millisecond precision and Hyperindex never overwrites a non-null value on update. Ties break by `uri`, compared with the database collation.

The cursor is unpadded base64url JSON, scoped to the selected feed: exactly `{ version: 3, feedId, value: { value, uri } }`. `value` and `uri` are the last row the previous page consumed, and the next page selects rows strictly after it. Nothing a record controls is in the cursor, so no record can make it outgrow the 4,096 characters the response allows. The cursor is an unsigned token held by the client, so the service trusts it only to position that client's own page. A `value` that is a valid RFC 3339 datetime but that PostgreSQL cannot cast, namely a day the month does not have (`2026-02-30`), year 0000, or a UTC offset beyond ±15:59, is rejected as `InvalidCursor` when the cursor is decoded. Cursors of versions 1 and 2 are rejected with `InvalidCursor`; clients request the first page again. Pagination is deterministic for each query but is not a snapshot across requests.

### Dates

`createdAt` is client-declared, so the feed reads only rows with `record_created_at` from 1970-01-01T00:00:00Z up to five minutes after the statement's `now()`. Hyperindex accepts any datetime Indigo parses, so a valid record dated `9999-12-31T23:59:59-05:00` is stored as year 10000, which PostgreSQL accepts but which is not a valid datetime on the wire; one such row would fail every page that includes its kind. A record dated far in the future would otherwise stay at the top of the feed forever. Rows outside the range are ignored until their time arrives. Every read of `record` in the statement applies the same range, written out as literals so the planner can still walk the timeline index in order.

### Rows, groups, and pages

**The statement is a plain read.** It returns the next 500 selectable rows after the cursor, newest first, and nothing else: no grouping, counting, or cutting. Each row is `kind`, `uri`, `cid`, `did`, the formatted `record_created_at`, and what the page builder needs to group it: for audio the folder (`deploymentRef` when it is an AT-URI) and its owner, for observations whether it is a bioacoustic sighting, and for reposts the subject.

**The page is built in TypeScript.** `src/feed/query.ts` fetches batches and `src/feed/page-builder.ts` folds their rows into cards, newest first:

- A **group** is the audio recordings of one owner and folder, or the observations of one account. Bioacoustic sightings, reposts, posts, projects, and organizations never group; each is its own card.
- A row of a group **joins the group's open card** when it is no more than 12 hours older than that card's oldest row so far (a gap of exactly 12 hours joins). Other rows between them, of any kind, account, or folder, change nothing. A row further away starts a new card for the group and closes the old one. Two cards of one group can therefore share a page.
- A card is placed at its newest row. A group card of **at least 3 rows** is a `groupItem`: `total`, `from`, `to`, up to 20 sample URIs, and the `groupKey`. A card of fewer rows is returned as separate `recordItem`s, each at its own row's position, so groups of one or two rows look exactly like the rows around them.
- The page takes `limit` cards. It stops at the first row that would start another card, at the end of the data, or after the request has consumed 5,000 rows. Rows that join an open card are taken even when the page has its `limit` cards, so one page can cover a whole dump.
- Every consumed row is in exactly one item, and the cursor is the last consumed row, so no row repeats and none is skipped.

**`limit` counts cards while the page is built.** A group that ends with fewer than 3 rows becomes up to 2 records, so a page holds between `limit` and `2 × limit` items. It holds fewer when the end of the data or the row budget stops it first. This is documented in the Lexicon, because a client that sizes its screen by `limit` sees it.

**The row budget.** A request consumes at most 5,000 rows, which is at most 10 statements of 500 rows. When the budget ends a page, the page always has a cursor (it cannot know that no row remains, so the next page is empty when the data ended exactly there), and a group card says `more: true` when a later row can still join it: it is its group's latest card, and the page's last consumed row is within 12 hours of the card's oldest row. A card whose group has gone quiet for more than 12 hours before the page ended cannot be continued, so it does not say `more`.

**A group can continue on the next page.** The page builder keeps no state between requests, so the continuation of a group comes back as another card with the same `groupKey`. The `groupKey` is a stable hash of the group's kind, owner, and folder: it names the group and is the same on every page and in every request. A client merges a later card into an earlier one by the rule the Lexicon documents on `groupItem`: keep the last card shown for each `groupKey`, and when a later card with that key has a `to` no more than 12 hours before that card's `from`, add its `total`, take its `from` and `more`, and append its `subjects`. Otherwise it is a new card. Most merging happens inside the service, so the client rule matters only at page edges and for groups longer than the row budget. The absence of `more` does not mean that a group is complete: a group also continues after a page that ended for another reason, so clients always merge by `groupKey` and the 12-hour rule, never by `more`. A continuation of fewer than 3 rows is returned as separate records and is not merged.

**Audio owner and folder.** A recording whose `deploymentRef` is an AT-URI belongs to that recorder folder, and the folder's owner, the account in the AT-URI, owns the group whoever stored the recording. A recording without a folder belongs to its own account. If the authority of the AT-URI is not a valid DID, because it is a handle or anything else, the recording also falls back to its own account, because `groupItem.did` must be a DID. A valid DID here is the shape the Lexicon's `did` format accepts: `did:method:id`, a lowercase method, the characters `A-Z a-z 0-9 . _ : % -`, no trailing `:` or `%`, at most 2,048 characters. The card names the folder in `groupItem.deployment` only when `deploymentRef` is a valid AT-URI, by the strict `isAtUriString` test, which is also what the output check of `format: at-uri` applies. For any other value (`at://did:/x`, a trailing slash, a query, a path that is not a collection and a key) `deployment` is omitted and the recordings still group by the raw `deploymentRef`, with the owner rule above. One malformed `deploymentRef` therefore cannot fail the page that holds it. A recording shown as a `recordItem` names the account that stored it in `did`; the owner of its folder is only the group's. The app also looks the folder up and falls back to the recording's account when the folder record is missing; the service reads the owner from the AT-URI and does not look the folder up.

**Bioacoustic sightings.** An observation whose `dynamicProperties` text parses to a `gainforestBioacoustics` sidecar with version 1, a source audio URI that appears in `associatedMedia`, a known label category, and numeric time and frequency bounds is shown on its own, with its spectrogram. The statement parses the sidecar only for observations whose text mentions it.

**Reads per request.** One statement answers a request whose first batch holds the page, which is nearly every request. A page that folds a long dump needs a statement per 500 rows it consumes, and a request never runs more than 10, so it never reads more than 5,000 rows. When a batch ends exactly where the page ends, one more statement shows that the next row starts a card. Each statement is bounded by the statement timeout, so a request is bounded by 10 of them. Nothing is retried: a statement that exceeds the statement timeout is a database problem and surfaces as `InternalError`. A request fetches at most 5,000 rows and consumes fewer when the page ends inside a batch: the rest of that batch is read and dropped.

## Hyperindex behavior the feed depends on

**Validation status and revalidation.** Migration 012 adds `validation_status` with the default `'unknown_schema'`. Rows that predate the migration, and rows of a collection that has no saved lexicon, stay `unknown_schema` until Hyperindex validates them (its startup validation refresh reads `record` by `(collection, uri)`; see migration 014). The feed selects only `valid` rows, so a table that has not been revalidated gives an empty or partial feed, while `/ready` stays green: readiness checks that the columns and the grant exist, not what the rows contain. Before cutover, confirm that the collections the feed reads are validated, for example with a read-only login:

```sql
SELECT collection, validation_status, count(*)
FROM record
WHERE collection IN (
  'org.hypercerts.collection', 'app.certified.actor.organization',
  'app.gainforest.feed.post', 'app.gainforest.feed.repost',
  'app.gainforest.dwc.occurrence', 'app.gainforest.ac.audio'
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
record_pkey ON record (uri)                                    -- repost subject lookups
```

The per-kind arms walk `idx_record_timeline_collection_created`, in index order and only as far as the merged batch needs. The subject of each repost is read by primary key. The `scripts/test-hyperindex-schema.sh` preflight checks that `idx_record_timeline_collection_created` exists. It also still checks `idx_record_did_collection` (`record (did, collection)`, migration 001), which the activity feed statement does not read.

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

PostgreSQL estimates that the post filters match very few rows (about 9, where about 3,000 match). The statement hides its limit from the planner, which keeps the post arm on the ordered timeline index: a posts-only request takes about 1.3 ms of execution on the evidence data below, so the index is not needed there. Build it only if the plan of the post arm on the production-shaped table shows a Bitmap Heap Scan and a sort: with a visible limit that was the plan, and it read every post of the collection for every request that included posts.

### Evidence from scratch databases

These numbers come from a throwaway local PostgreSQL 16.15 cluster with the real Hyperindex migrations 001 through 014 applied and synthetic data shaped like the staging table when pages started fragmenting. They are warm-cache measurements with JIT off, not a benchmark. The table had 172,095 rows: 39,362 observations (16,044 of them invalid), 63,107 audio recordings (two recorders with 1,700 and 1,400 recordings in the last few hours, uploaded at the same time, three and four seconds apart), 4,025 posts, 1,900 collections (about 760 typed project), 101 organizations, 600 reposts, and 63,000 rows of collections the feed ignores (3,000 of them follow records).

One request, the wall-clock time of `FeedService.getFeed` (median of seven runs), the statements it sent, and the sum over those statements of the planning and execution time that `EXPLAIN (ANALYZE, BUFFERS)` reports (the minimum of seven runs each):

```text
                                                        statements   request   planning + execution
all kinds, limit 20, page 1 (holds the 3,100-row dump)       7        40 ms      6.9 + 14.4 ms
all kinds, limit 50, page 1 (the same dump)                  7        38 ms      7.0 + 14.4 ms
all kinds, limit 20, pages 2, 3, 6, 12                       1       7 ms        1.0 + 4.1-4.2 ms
all kinds, limit 20, cursor inside the dump (row 1,000)      5        25 ms      5.0 + 10.8 ms
audio only, limit 20, page 1 (holds the dump)                8        35 ms      5.5 + 13.2 ms
audio only, limit 50, page 1                                10        43 ms      7.4 + 17.3 ms
audio only, limit 20, cursor inside the dump (row 1,000)     6        25 ms      4.0 + 9.8 ms
observations only, limit 20 / 50                             1       6 / 8 ms    0.7 + 4.1 ms
posts only / projects only, limit 20                         1       3 / 4 ms    0.7 + 1.3 / 1.5 ms
```

A statement of 500 rows costs about 1 ms of planning and 1.3 ms (posts, projects), 2 ms (audio), or 4 ms (observations, each with a text test for a bioacoustic sidecar) of execution. A request that folds the whole 3,100-row dump needs 7 statements; the most a request can need is 10, about 43 ms here. Through the HTTP application, with the output check, `getFeed` took 44 to 49 ms for the three pages that fold a dump, and `getFeedSkeleton` 48 to 49 ms for the all-kinds pages, whose skeleton holds 3,230 entries (284 KiB); an audio-only skeleton of 4,934 entries (434 KiB) took 54 ms.

No plan used a bitmap scan on a feed collection, a sequential scan, or a sort that left memory. The only sorts are 25 kB sorts of arms that the kind filter switched off, which return no rows. The estimated cost of the statement is about 2,200 on this table, far below PostgreSQL's default `jit_above_cost` of 100,000, so JIT did not start; it grows with the table because the limit is hidden from the planner, and the pool switches JIT off.

What keeps the plan this way is listed in the header of `src/feed/feed-query.sql`. In short: every arm and the merged stream take their limit from a subquery, because a visible limit makes PostgreSQL leave the ordered index scan of an arm whose filter it thinks is selective (the post arm) for a bitmap scan and a sort of the whole collection; the cursor is an inline predicate so a deep page is an index condition; and the audio folder and the sidecar are read once per row.

Known follow-ups, deliberately not built:

- **Planned: a separate following feed.** Following is not part of `activityFeed` and not part of this release. It is planned as its own feed id (`#followingFeed`) with its own params definition in the `params` open union, and a follow-driven query: it starts from the followed accounts and reads each one's records through the author index `idx_record_timeline_author_collection_created` (`did, collection, record_created_at DESC, uri DESC`), merging the results, instead of walking each collection and filtering by owner. Audio ownership through the recorder folder is still to be handled: the owner of a recording is the folder's owner from `deploymentRef`, not the account in `did`, so that index cannot find the recordings that other accounts stored in a followed account's folder, and the query would have to find the folders the followed accounts own as well as their own recordings.
- A statement always asks each arm for up to 500 rows, so a request that needs a handful of rows still reads the rows its arms produce for the merge (about 4 ms of execution on this table, most of it for observations). A smaller first batch would make ordinary pages cheaper and long dumps cost more statements; 500 is the batch the design was approved with.
- The estimated cost of the statement grows with the number of rows in the collections, because PostgreSQL plans for the first tenth of the rows (about 2,200 on the evidence data). The pool opens every session with `-c jit=off` (`src/database.ts`), so no table size can start JIT compilation, which would add 100 to 150 ms to every statement. Nothing needs to be configured on the database.

## Schema preflight and integration tests

The behavior suite runs on an explicitly chosen, empty, disposable PostgreSQL 16+ database. It creates `public.record` with the Hyperindex columns and indexes above when the database has none, copies it into a private schema for each test, and drops that schema afterwards. It does not drop or truncate `public.record`. Never target a shared, staging, or production database.

To check a database that Hyperindex has migrated before running the same suite:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/hyperindex_feed_test' \
  npm run test:integration:hyperindex
```

The command requires `psql`, checks PostgreSQL 16+, the `record` columns, and the two indexes it names (`idx_record_timeline_collection_created` and `idx_record_did_collection`), then runs `npm run test:integration`. It does not apply migrations. The suite's direct SQL fixture loading does not exercise Hyperindex's ingestion path or its `record_created_at` materialization.
