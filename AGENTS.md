# Hypercerts Feed Service agent guide

## Read this first

This repository is a standalone, read-only TypeScript service exposing two POST procedures with optional AT Protocol service authentication:

```text
org.hypercerts.feed.getFeedSkeleton
org.hypercerts.feed.getFeed
```

The skeleton returns URI-only generic feed subjects. The hydrated endpoint returns generic feed entries with validated feed-specific views and actor summaries. HappyView is the database owner. The service reads its current PostgreSQL state directly; it does not ingest, write records, own migrations, cache feed results across requests, call HappyView/PDS/AppView APIs, download blobs, hydrate target records, or provide immutable history. Optional service auth verifies the issuer's `#atproto` signing key, audience, expiry, endpoint binding, and DID document over a bounded secure resolver; the verified issuer, never the body, supplies an authenticated viewer. It retains only bounded, process-local replay-protection state through the JWT `jti`; that state is not a feed-result cache.

Use **npm**, not pnpm. `package-lock.json` is authoritative. Node.js 22.19+ is supported; CI and Docker use Node.js 24. PostgreSQL 16+ is required.

Before changing feed behavior, read together:

- `src/feed/feed-query.sql` — primary selection, classification, ordering, pagination, and same-statement source contract
- `src/feed/query.ts` — registered HappyView-backed Hypercerts feed definition, fixed SQL bind order, row mapping, and source invariants
- `src/feed/registry.ts` and `src/feed/sql-feed.ts` — feed dispatch plus shared parsing, cursor, execution, pagination, and metrics policy
- `test/feed.integration.test.ts` — cross-table, source-mode, and pagination invariants
- `docs/database-contract.md` — HappyView schema, current-state, and label-projection contract

## Commands

```bash
npm install                    # local setup; use npm ci for a clean reproducible install
npm run dev                    # watch TypeScript and src/feed/feed-query.sql
npm run codegen                # regenerate ignored Lexicon TypeScript
npm run changeset              # add a versioned release-note fragment
npm run changeset:empty        # add a no-version-bump fragment
npm run check                  # strict TypeScript check
npm test                       # unit tests; equivalent to npm run test:unit
npm run build                  # codegen, compile, copy SQL, smoke-load production adapters
```

Integration tests require an explicitly chosen empty disposable PostgreSQL 16+ database:

```bash
TEST_DATABASE_URL='postgresql://...' npm run test:integration
```

To test against an isolated database already migrated with HappyView's schema:

```bash
TEST_DATABASE_URL='postgresql://...' npm run test:integration:happyview
```

Never target a shared, staging, or production database. The suite creates contractual tables and rows but does not drop or truncate existing tables. `test:integration:happyview` requires `psql`, checks the HappyView columns used by the service, then runs the behavior suite. The suite writes synthetic records and labels and does not apply migrations. It does not test real record or label ingestion; never target a shared, staging, or production database.

CI runs:

```text
npm ci -> npm run check -> npm test -> npm run test:integration -> npm run build
```

There is no lint or formatting command. Follow existing style: ESM, NodeNext `.js` import suffixes, single quotes, no semicolons, narrow interfaces, and no unrelated reformatting.

## Architecture and ownership

Skeleton call stack:

```text
src/server.ts
  -> src/app.ts
  -> src/api/get-feed-skeleton.ts
  -> FeedService
  -> FeedRegistry.loadPage(metadata)
  -> registered HappyView-backed SQL feed
  -> src/feed/feed-query.sql, source mode disabled
  -> Database
```

Hydrated call stack:

```text
src/server.ts
  -> src/app.ts
  -> src/api/get-feed.ts
  -> HydratedFeedService
  -> FeedRegistry.loadPage(with-source)
  -> registered HappyView-backed SQL feed
  -> src/feed/feed-query.sql, source mode enabled
  -> validateFeedRecord(), dropping invalid selected sources
  -> IdentityReader.getByDids()
  -> validateCertifiedProfile()
  -> buildActorSummary() / buildFeedItemView()
```

Ownership:

- `src/server.ts` is the composition root. It creates the registered Hypercerts feed, one shared registry, separate endpoint services, one identity adapter, and the configured optional service-auth verifier; that verifier owns one replay map shared by both endpoints; it also owns listener settings, initial readiness, and graceful shutdown.
- `src/app.ts` is the fetch-compatible boundary. It owns fixed route metadata, POST enforcement, the 64 KiB body limit, malformed JSON, routed validation messages, and bounded request metrics.
- `src/api/get-feed-skeleton.ts` and `src/api/get-feed.ts` register the procedures, run generated output validation inside the error boundary, and translate expected `FeedError` values.
- `src/feed/service.ts` projects registry-selected metadata rows into the public skeleton. It does not own dispatch, cursor, or pagination policy.
- `src/feed/registry.ts` owns `feedId` dispatch, feed/params compatibility checks, and the shared metadata/source page interface used by both endpoint services.
- `src/feed/sql-feed.ts` owns feed-specific parameter parsing and normalization calls, feed-scoped cursor decoding, one query execution/timing, `limit + 1` trimming, result metrics, source-mode enforcement, and next-cursor creation.
- `src/feed/query.ts` registers the current HappyView-backed Hypercerts feed and owns its generated parameter parsing, fixed SQL bind order, metadata/source row mapping, and explicit query invariants.
- `src/feed/feed-query.sql` owns scope resolution, quality and endorsement rules, project pairing, classification, ordering, keyset pagination, and the conditional post-pagination source join.
- `src/hydration/service.ts` directly coordinates source validation, omission of invalid selected sources, DID discovery, at most one identity batch, identity projection, total view construction, and output ordering. It must not call the public skeleton service.
- `src/hydration/identity.ts` owns the batched current Certified-profile query and returns one context per requested DID.
- `src/hydration/validation.ts` owns strict source/profile validation. `src/hydration/views.ts` owns pure identity precedence and kind-specific view construction. Neither performs I/O.
- `src/database.ts` is the only PostgreSQL pool owner.
- `src/metrics.ts` owns an isolated Prometheus registry with bounded labels.

## Test seams

Test at the narrowest owner:

- app tests fake `FeedSkeletonReader` and `HydratedFeedReader`;
- skeleton-service tests fake `FeedPageLoader`;
- hydrated-service tests fake `FeedPageLoader` and `IdentityReader`;
- registry tests fake registered feeds and assert dispatch invariants;
- generic SQL-feed tests fake the query executor and assert parsing, cursor, pagination, mode, timing, and metrics policy;
- Hypercerts-feed query tests fake the query executor and assert bind/source invariants;
- identity tests fake its query executor;
- validation and views use pure fixture tests;
- Lexicon tests inspect committed JSON and generated parsers;
- PostgreSQL integration tests own SQL, schema, cross-table, source-mode, and pagination behavior.

## Release workflow

Add a Changeset when a pull request affects application behavior, runtime configuration, the public contract, supported runtime versions, service deployment, or operator procedures. This includes changes to feed selection, filtering, pagination, hydration, request parameters, responses, and public errors. Do not add a Changeset for local development tools, tests, behavior-preserving internal refactors, documentation-only corrections, or repository and CI maintenance that does not affect the service or its operators. CI does not infer semantic release impact; contributors and reviewers own this decision. When a pull request does include a Changeset fragment, CI validates it with `changeset status` so malformed release metadata cannot reach `main`.

Changesets creates or updates the `changeset-release/main` Release pull request with `GITHUB_TOKEN`. Current GitHub behavior creates its CI runs in an approval-required state. A maintainer must approve those runs and wait for the full PostgreSQL-backed CI suite before merging. The release workflow then validates the exact merged commit before creating the private package's Git tag and GitHub Release. It does not publish to npm or deploy the service. See `docs/RELEASING.md` for the complete flow.

## Canonical and generated files

- Project-owned `lexicons/org/hypercerts/feed/**/*.json` is the public wire contract. Active external Lexicon dependencies are pinned by `lexicons.json`; refresh them only through `lex install`. `lexicons/app/bsky/actor/profile.json` is preserved locally but is no longer an active dependency or used by identity hydration.
- `src/lexicons/` is generated and ignored. Never hand-edit or commit it.
- `src/feed/feed-query.sql` is the canonical feed statement.
- `dist/` and `coverage/` are generated and ignored.
- `npm run build` must copy the feed SQL beside `dist/feed/query.js` and smoke-load every production adapter without starting the server.

The current `@atproto/lex` generator emits explicit `l.typedObject<T>` and `l.record<Key, T>` calls whose optional fields are incompatible with this repository's `exactOptionalPropertyTypes: true`. `npm run codegen` therefore runs `scripts/fix-generated-feed-defs.mjs`, which removes only those explicit schema generics from ignored generated definitions. It does not change Lexicon JSON or runtime validators. Keep the workaround narrow. Remove the script and package-script hook only after an upstream generator version supports exact optional properties and `npm run check`, parser contract tests, and `npm run build` pass without it.

A request, response, event kind, view, or public-error change normally requires coordinated updates to Lexicon JSON, domain types, service behavior, tests, and README. A schema-dependent change normally requires SQL, bind mapping, integration-test, and database-contract updates.

## Feed and hydration invariants

Preserve these unless the public contract is intentionally revised and documented:

- Both procedures accept the same `{ feedId, params?, limit?, cursor? }` wrapper. `limit` and `cursor` are generic top-level pagination controls; `params` contains only algorithm-specific values and may be omitted for feeds that declare no params contract. The public params union remains open for future feeds. Runtime dispatch rejects an unregistered `feedId` with `UnsupportedFeed`, while the current Hypercerts feed rejects missing params or a mismatched params discriminator with `InvalidRequest` before querying.
- The base scope always resolves from the normalized viewer's current Certified follows. Anonymous requests require `params.viewerDid`; authenticated requests may omit it, but a supplied value must exactly match the verified service-auth issuer. There is no caller-supplied author override or body-based override of authenticated identity.
- Authenticated tokens must carry a non-empty string `jti` of 1–256 UTF-8 bytes. After successful signature and exact `lxm` verification, each issuer-and-`jti` pair is consumed once in the shared process-local replay map, with a maximum of 512 live entries per verified issuer and 4,096 live entries total. Expired entries are purged without evicting live entries; a live full issuer quota or global map fails closed with HTTP 503. The map is cleared on restart and is not replica-global. Downstream failures do not restore a consumed token.
- Deduplicate request lists before enforcing semantic limits: 64 evaluators, 16 kinds, and 1–50 page items.
- Evaluator endorsement subjects are unioned after base-author resolution. Remove the viewer and deduplicate candidates. Do not query actor status: only current records present in HappyView affect feed selection.
- Omitted or empty `kinds` means all supported kinds. Unknown kinds fail with the generic `InvalidRequest` error and an actionable Hypercerts-parameter message.
- Organization-quality policy uses only service-configured `TRUSTED_QUALITY_LABELER_DIDS`. Organizations are exact `app.certified.actor.organization/self` records. Quality labels are trusted bare-DID rows in HappyView's current positive `happyview_labels` projection; `cts` and `exp` are TEXT and must be complete finite RFC3339 or legacy PostgreSQL timestamp strings. Validate shape and `pg_input_is_valid` before casting; malformed, date-only, and nonfinite values are inactive. `cts` is not used for ordering. HappyView removes negated rows and stores no label CID or history. Direct SQL fixtures do not prove stream ingestion or label completeness. `includeUnrated` applies only when no active trusted label exists; an active disallowed label is not unrated.
- Materialize the complete resolved scope once for project pairing and event selection. Do not cap or truncate followed or evaluator-expanded accounts.
- Evaluator expansion and visible endorsement events use the same JSON account-subject, self-endorsement, exact definition URI/CID, badge type, allowed-issuer, and latest exact response rules. Do not use derived endorsement adjacency data.
- Project/activity pairing happens before kind filtering and pagination. It requires the same actor, exact activity URI/CID, and an effective timestamp gap strictly below 60 seconds. Paired activities remain suppressed across pages.
- HappyView stores `record`, `indexed_at`, `created_at`, `cts`, and `exp` as TEXT. Parse JSON and timestamp text only in per-consumer guarded projections; require complete RFC3339 or legacy PostgreSQL timestamp shape, validate with `pg_input_is_valid`, and reject nonfinite values before casting. Invalid JSON is absent, malformed `createdAt` falls back to finite parsed `indexed_at`, and null, malformed, date-only, or nonfinite fallback timestamps do not enter the feed. Compare parsed timestamp values chronologically, never TEXT lexically. Ordering is effective timestamp descending, URI descending; `happyview_records.created_at` is ingestion time and is not used.
- The cursor payload is unpadded base64url JSON with exactly `{ version: 1, feedId, value: { value, uri } }`. It is scoped to the selected feed and stores the last selected source row before hydration. Ordering, formatting, tie-break, and cursor payload are one contract; dropping invalid hydrated sources must not change cursor advancement.
- Metadata and source-aware pages execute the registered feed statement once. Source JSON is joined only after `paged_events`; never carry it through candidate sorting.
- Feed selection and exact source retrieval share one PostgreSQL statement snapshot. A missing/mismatched final join is an internal invariant failure.
- Skeleton pages execute one feed query and expose only URI subjects, with no source CID, classification metadata, or source value. Hydrated pages with at least one validated source execute one feed/source statement plus one identity query. Empty or entirely invalid selected pages skip identity retrieval. Do not issue extra queries to refill dropped items; query count never grows with page size.
- Identity retrieval is a later current-state read. One batch selects only the current Certified profile record from `happyview_records`; do not join handles, Bluesky profile records, or actor status.
- Every requested identity DID receives a context. Missing storage rows degrade to a DID-only summary; query rejection fails the request.
- A valid meaningful Certified profile supplies supported display/avatar fields; otherwise the actor summary is DID-only. Do not expose provenance or handle/Bluesky fallbacks.
- Known source records validate against `@hypercerts-org/lexicon` exactly `1.0.0`, selected by trusted collection plus feed kind. Keep the compatible direct `@atproto/lexicon` pin and supplemental MIME, integer-size, nonnegative-size, and maximum-size checks.
- Public hydrated output is view-only. Every returned `org.hypercerts.feed.getFeed#feedItem` has a URI-only source `subject` and a required open `view`; the current `org.hypercerts.feed.defs#hypercertsFeedView` variant owns Hypercerts `kind`, `actor`, and open `content`. Drop invalid selected sources without backfilling; a hydrated page may be shorter than `limit`, or empty, while retaining the selected-page cursor. Do not expose source JSON, source CID, internal feed timestamp, or redundant event-author DID fields.
- Hydrated items use a direct local `feedItem` reference. Feed views, content values, and image values remain open unions. Preserve protocol-native `org.hypercerts.defs#uri`, `#smallImage`, `#largeImage`, and `#smallBlob` discriminators and nested AT Protocol blob refs; never add a feed-specific flattened blob descriptor. Require clients to tolerate unknown future variants.
- All seven supported feed kinds map exhaustively to six known view variants; both collection kinds use `collectionView`. The service owns this kind/view mapping.
- Endorsement views are total and use the exact account-subject summary.
- Evaluation, measurement, and update targets are exact strong references only. Do not query target records, discover target identities, build previews, or recurse.
- Results are mutable current state, not snapshots across requests or an event log.

## Database and operational safety

HappyView owns `happyview_records`, `happyview_labels`, their migrations, and indexes. This repository must not apply migrations, create indexes, refresh materialized views, or write cursor state. Parameterize every caller-controlled SQL value. Index changes belong in HappyView and require production-shaped `EXPLAIN (ANALYZE, BUFFERS)` evidence.

Use a deployment role with `SELECT` only. `default_transaction_read_only=on` is defense in depth, not a grant replacement.

`GET /ready` checks reachability, PostgreSQL 16 safe JSON/timestamp input-validation support, and read-only session state. It intentionally does not verify HappyView tables, migration completeness, labeler subscription health, label completeness, or ingestion freshness. `GET /health` is process liveness only.

`REQUEST_TIMEOUT_MS` bounds receiving a request, not total handler/query duration. Pool acquisition and statement timeouts are separate.

Keep errors actionable and stable without exposing SQL, credentials, contents, internal causes, or stacks. Never use DIDs, AT-URIs, CIDs, cursors, or record values as metric labels.

Rate limiting belongs at the gateway. Keep `/health` and `/ready` private.

## MVP exclusions

Do not add ingestion, writes, stronger authentication modes, feed-result caching across requests, immutable history, HappyView/PDS/AppView API calls, blob downloads/proxying, target-record reads, target previews, recursive/detail hydration, activity-label hydration, preference persistence, or migrations/indexes. Service-auth verification is limited to the maintained AT Protocol verifier and the bounded DID-resolution boundary described above; retain only bounded, process-local replay-protection state through the JWT `jti`, and never log authorization credentials, JWTs, or claims.

## Change checklist

1. Inspect branch and working tree; preserve unrelated or in-flight changes.
2. Change only the owning layer and coupled contracts.
3. Add focused tests. SQL behavior requires PostgreSQL integration coverage.
4. Update Lexicons and documentation for public behavior changes.
5. Add a Changeset when the change has release impact under the release workflow policy.
6. Run `npm run check`, `npm test`, `npm run build`, and `git diff --check`.
7. Run integration tests only with an explicitly selected disposable PostgreSQL database.
8. Report commands, failures, and unavailable validation.
