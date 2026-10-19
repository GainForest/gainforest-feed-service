# Database contract

The feed service reads HappyView's current PostgreSQL state directly. HappyView owns the tables, migrations, indexes, and ingestion. This document describes the schema and current-state semantics consumed by independently deployed repositories; it does not make this service an ingestion owner.

## Readiness and compatibility

`/ready` checks that PostgreSQL is reachable, supports `pg_input_is_valid`, and is running with a read-only session. It does not check HappyView tables or columns, migration history, subscription health, label completeness, backfill state, or ingestion freshness. Schema mismatches fail the feed query or the explicit integration preflight, not readiness.

PostgreSQL 16 or newer is required because the feed query uses `pg_input_is_valid` to guard casts from HappyView's TEXT-backed JSON records and timestamp fields.

## Runtime schema

The service reads these HappyView-owned tables in `public`:

```text
happyview_records.uri          text, primary key
happyview_records.did           text
happyview_records.collection    text
happyview_records.rkey          text
happyview_records.record        text (JSON-encoded record)
happyview_records.cid           text
happyview_records.indexed_at    text, nullable (timestamp text)
happyview_records.created_at    text (timestamp text)

happyview_labels.src            text
happyview_labels.uri            text
happyview_labels.val            text
happyview_labels.cts            text (timestamp text)
happyview_labels.exp            text, nullable (timestamp text)
```

`happyview_labels` has a primary key on `(src, uri, val)`. The feed does not read an `actor` table. Record reads use `uri`, `did`, `collection`, `record`, `cid`, and `indexed_at`; `created_at` is HappyView's database-ingestion timestamp and is not a feed timestamp. The integration fixture uses `rkey` and supplies a TEXT `created_at` value because the migration removes its default.

The adapter expects HappyView's prefixed table names. Migration `20260318000000_uuid_to_text.sql` converts record JSON and the relevant timestamps to TEXT. `20260325000000_text_to_timestamptz.sql` is explicitly a no-op; later migrations add an index or rename the tables to `happyview_records` and `happyview_labels` without restoring native types. This repository must not apply those migrations, create compatibility views, or write to the production database.

## Read-only access

Use a dedicated role with `SELECT` only on the two runtime tables. `default_transaction_read_only=on` is defense in depth, not a replacement for grants.

```sql
CREATE ROLE hypercerts_feed_reader LOGIN PASSWORD '<managed-secret>';
GRANT CONNECT ON DATABASE happyview TO hypercerts_feed_reader;
GRANT USAGE ON SCHEMA public TO hypercerts_feed_reader;
GRANT SELECT ON TABLE public.happyview_records, public.happyview_labels
  TO hypercerts_feed_reader;
ALTER ROLE hypercerts_feed_reader SET default_transaction_read_only = on;
```

Before configuring `DATABASE_URL`, verify using that login that it can connect, select both tables, and reports a read-only session. Keep the database private to the service network.

## Feed records and identity

Feed selection reads current rows from `happyview_records`. The service does not query PDS, AppView, HappyView APIs, or actor-status tables. A missing source row produces no feed event; there is no history or snapshot guarantee across requests.

The supported source collections are:

```text
app.certified.graph.follow
app.certified.actor.organization
app.certified.actor.profile
app.certified.badge.award
app.certified.badge.definition
app.certified.badge.response
org.hypercerts.claim.activity
org.hypercerts.collection
org.hypercerts.context.evaluation
org.hypercerts.context.measurement
org.hypercerts.context.attachment
```

Hydration makes one later batch query for the current `app.certified.actor.profile/self` row of each requested DID. A valid, meaningful Certified profile can supply the display name and avatar; otherwise the actor summary contains only the DID. The service does not join HappyView handles or `app.bsky.actor.profile` records. Missing profile rows do not remove feed items; identity-query failures fail the hydrated request. Empty or entirely invalid selected pages skip identity retrieval.

## Query ownership and page semantics

`src/feed/feed-query.sql` owns one parameterized statement for both skeleton and hydrated pages. `src/feed/query.ts` owns the fixed bind order, row mapping, cursor codec, and exact-source invariants. `src/feed/registry.ts` and `src/feed/sql-feed.ts` own dispatch and shared SQL-feed execution policy.

The statement performs these steps:

1. Resolve the viewer's current Certified follows.
2. Resolve valid account-subject awards from configured trusted evaluators, using the same award rules as visible endorsement events.
3. Union and deduplicate the scope, then remove the viewer.
4. Identify organizations by the exact current `app.certified.actor.organization/self` URI and collection.
5. Apply the optional trusted quality-label policy to the complete resolved scope.
6. Materialize that full scope for project pairing and event selection.
7. Pair collections with their exact activity strong references before kind filtering and pagination.
8. Select eligible current records, classify them, apply the kind filter and keyset cursor, and order by effective timestamp descending then URI descending.
9. Select `limit + 1` metadata rows. For hydrated mode only, join those page rows back to `happyview_records` by exact URI, CID, and collection to obtain source JSON.

Every caller-controlled SQL value is bound. TEXT-backed JSON is decoded only in per-consumer guarded projections; no whole-table JSON conversion is materialized, and source text is not carried through candidate sorting. Metadata and source-aware pages execute the same statement once; the final source join retrieves raw source text after pagination, so selection and source retrieval share one PostgreSQL statement snapshot. The adapter decodes only those selected source values; malformed source JSON is treated as invalid and hydration omits it without refilling the page. A missing or mismatched source join is an internal invariant failure.

Skeleton pages expose URI-only subjects. Hydrated pages validate the selected source values, omit invalid values without refilling the page, and preserve the cursor for the selected source page. With at least one valid source, hydration performs one identity batch regardless of page size. Source JSON, CIDs, internal timestamps, and redundant actor DIDs are not returned.

## Organization-quality labels

Only label sources in `TRUSTED_QUALITY_LABELER_DIDS` participate. The feed matches organization labels to the bare DID in `happyview_labels.uri`; record AT-URIs do not match. The recognized values are `high-quality`, `standard`, `draft`, and `likely-test`.

HappyView stores a positive current-state projection keyed by `(src, uri, val)`. A received negation deletes the matching row. The projection has no `neg` column, label CID, or history, so the service cannot evaluate negation ordering, recover prior labels, distinguish CID-specific label events, or prove that all labels have been ingested. A row means only that HappyView currently projects that source, subject, and value.

`cts` and `exp` are TEXT values converted from the label event's PostgreSQL timestamps. Both must have a complete, finite timestamp shape: RFC3339 with a timezone, or the legacy PostgreSQL `timestamptz::text` form (`YYYY-MM-DD HH:MM:SS[.fraction]±HH[:MM[:SS]]`). SQL checks the shape, validates with `pg_input_is_valid`, and rejects nonfinite values before casting. `cts` is validated but does not order labels; an absent `exp` is active, a valid future expiry is active, and malformed, date-only, nonfinite, or elapsed expiries are ignored. Invalid `cts` rows are ignored. Values outside the recognized quality set do not count as active known labels in this feed version.

When an organization-quality policy is supplied, an organization with any active trusted recognized label is included only if at least one such value is allowed. `includeUnrated` applies only when there is no active trusted recognized label; it does not admit an organization that has an active but disallowed recognized label. Non-organizations bypass the organization-quality filter.

The PostgreSQL integration fixture inserts synthetic `happyview_labels` rows directly. This tests feed policy against the projection schema, not label ingestion. The suite does not prove that a real label stream is connected, current, or complete. HappyView's labeler client validates TLS using standard Web PKI roots; a self-signed local mock cannot feed labels through the real subscription. Do not describe fixture-loaded labels as labels ingested from a real HappyView stream.

## Record timestamps, ordering, and cursors

For each record, the effective feed timestamp is a valid top-level JSON `createdAt` when present, otherwise `happyview_records.indexed_at`. Both `record` and `indexed_at` are TEXT. Each consuming SQL projection validates JSON text with `pg_input_is_valid(..., 'jsonb')` before casting; invalid JSON behaves as absent for selection and timestamp extraction. The service accepts `createdAt` only in its complete RFC3339 timestamp form, rejects the unknown-offset marker `-00:00`, validates it before casting, and safely falls back to `indexed_at` when missing, malformed, or unsupported. The `indexed_at` fallback accepts complete RFC3339 or legacy PostgreSQL `timestamptz::text` values as described above; shape, input validity, and finiteness are checked before casting. Null, malformed, date-only, and nonfinite fallback timestamps make the record ineligible unless a valid JSON `createdAt` supplies the effective time. Timestamp ordering and latest-response tie-breaking compare parsed timestamp values, never TEXT lexically. HappyView's `created_at` is not used.

The same effective timestamp drives feed ordering, cursor values, collection/activity pairing, and latest endorsement-response ordering. Latest response ordering uses parsed effective timestamp first, parsed `indexed_at` second, then URI descending. Malformed response JSON or timestamps cannot abort the feed query; unusable responses are ignored. Feed ordering is:

```text
effective timestamp DESC, URI DESC
```

Cursor version 1 is unpadded base64url JSON containing exactly `{ version: 1, feedId, value: { value, uri } }`. The cursor is scoped to the selected feed and records the last selected source row before hydration. Its descending keyset predicate is:

```sql
effective_at < position.value
OR (effective_at = position.value AND uri < position.uri)
```

Pagination is deterministic for each query but does not create a snapshot across separate requests while HappyView state changes.

## Project pairing

A collection and activity produce one `project.created_with_cert` event only when they have the same DID, the collection item contains the exact activity URI and CID, and their effective timestamps differ by strictly less than 60 seconds. Pairing is computed before kind filtering or pagination; paired activities remain suppressed on later pages.

## Endorsement selection

Evaluator expansion and visible endorsement events share one SQL rule. An award must have an account subject typed as `app.certified.defs#did`, a valid subject DID, and a non-self issuer. Its badge strong reference must match the current definition URI and CID, and the definition must be an endorsement. If `allowedIssuers` is present, it must be an array containing the exact issuer DID; malformed values fail closed. The latest non-empty subject-authored response for the exact award URI and CID controls activity; only `rejected` deactivates it, and no response leaves it active. Record-target awards do not expand or expose an account endorsement. The service does not use derived endorsement adjacency data.

## Schema preflight and integration tests

Run the behavior suite on an explicitly selected, empty, disposable PostgreSQL database. It creates the minimal HappyView-shaped tables if absent and inserts synthetic records and labels; it does not drop or truncate existing tables. Never target a shared, staging, or production database.

To check an isolated database already migrated with HappyView's schema before running the same suite:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/happyview_feed_test' \
  npm run test:integration:happyview
```

The command requires `psql`, checks PostgreSQL 16+ and the table columns used by the contract, and then runs `npm run test:integration`. It does not apply migrations. The suite's direct SQL fixture loading does not exercise HappyView's record or labeler ingestion path.

## Performance ownership

Before production traffic, measure the query against production-shaped data with `EXPLAIN (ANALYZE, BUFFERS)` for small and large follow scopes, evaluator expansion, organization-quality filtering, and both metadata and source-aware modes. Verify that the source JSON join remains after pagination and that the identity query stays bounded to requested DIDs. HappyView owns indexes and query-plan changes; do not add migrations or indexes from this repository.
