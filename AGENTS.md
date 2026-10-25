# GainForest Feed Service agent guide

## Read this first

This repository is a standalone, read-only TypeScript service exposing two POST procedures with optional AT Protocol service authentication:

```text
app.gainforest.feed.getFeed
app.gainforest.feed.getFeedSkeleton
```

**`getFeed` returns references and selection metadata, not records.** Its items are AT-URIs, CIDs, account DIDs, timestamps, and group counts and samples. It never returns titles, text, images, or profile data. GainForest hydrates the referenced records itself through Hyperindex GraphQL. `getFeedSkeleton` runs the same selection and returns the same cursor, flattened to AT-URIs. Keep that statement in the README, the Lexicon descriptions, and here whenever the contract changes.

Hyperindex is the database owner. The service reads its current PostgreSQL `record` table directly. It does not ingest, write records, own migrations or indexes, cache feed results across requests, call Hyperindex/PDS/AppView APIs, download blobs, hydrate records, or provide immutable history. Optional service auth verifies the issuer's `#atproto` signing key, audience, expiry, endpoint binding, and DID document over a bounded secure resolver; the verified issuer, never the body, supplies an authenticated viewer. It retains only bounded, process-local replay-protection state through the JWT `jti`; that state is not a feed-result cache.

Use **npm**, not pnpm. `package-lock.json` is authoritative. Node.js 22.19+ is supported; CI and Docker use Node.js 24. PostgreSQL 16+ is required.

Before changing feed behavior, read together:

- `src/feed/feed-query.sql` — selection, ordering, burst and audio grouping, pagination, and the completeness flag
- `src/feed/query.ts` — the registered activity feed, fixed SQL bind order, row mapping, and the scan-window retry
- `src/feed/registry.ts` and `src/feed/sql-feed.ts` — feed dispatch plus shared parsing, cursor, timing, and metrics policy
- `test/feed.integration.test.ts` and `test/support/feed-model.ts` — the integration tests and the independent in-memory model they compare against
- `docs/database-contract.md` — Hyperindex schema, selection rules, indexes, and index proposals

## Commands

```bash
npm install                    # local setup; use npm ci for a clean reproducible install
npm run dev                    # watch TypeScript and src/feed/feed-query.sql
npm run codegen                # regenerate ignored Lexicon TypeScript
npm run lint                   # codegen via prelint, then strict typed ESLint
npm run lint:fix               # apply ESLint autofixes
npm run format                 # format maintained TS/MJS/MD/YAML/JSON files
npm run format:check           # verify Prettier formatting
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

To test against an isolated database already migrated with Hyperindex's schema (the service needs migration 010 for `record_created_at` and migration 012 for `validation_status`):

```bash
TEST_DATABASE_URL='postgresql://...' npm run test:integration:hyperindex
```

Never target a shared, staging, or production database. The suite creates `public.record` when it is absent, copies it into a private schema for each test, seeds synthetic records, and drops that schema afterwards. It does not drop or truncate `public.record`. `test:integration:hyperindex` requires `psql`, checks the Hyperindex columns and indexes the service uses, then runs the same suite. It does not apply migrations and does not test Hyperindex's ingestion or its `record_created_at` materialization.

CI and exact-commit release validation run:

```text
npm ci -> npm run codegen -> npm run lint -> npm run format:check -> npm run check -> npm test -> npm run test:integration -> npm run build
```

`npm run lint` also regenerates ignored Lexicon TypeScript through its `prelint` hook, so typed lint works from a fresh checkout. ESLint prohibits inline configuration (including disable comments) globally and bans `@ts-expect-error`, `@ts-ignore`, and `@ts-nocheck` in maintained TypeScript. ESLint excludes generated Lexicons, build output, coverage, dependencies, and release changelogs. Prettier formats maintained TypeScript, MJS, Markdown, YAML, project configs, and the project-owned feed Lexicons; `.prettierignore` excludes generated output, the lockfile, and release changelogs. SQL, Bruno `.bru`, shell, Dockerfile, and environment files are not formatted by these commands.

Follow existing code style: ESM, NodeNext `.js` import suffixes, single quotes, no semicolons, narrow interfaces, and no unrelated reformatting. Use `npm run format` only for the maintained file set listed above; never format generated artifacts.

## Architecture and ownership

Call stack for both procedures:

```text
src/server.ts
  -> src/app.ts
  -> src/api/get-feed.ts | src/api/get-feed-skeleton.ts   (via src/api/feed-procedure.ts)
  -> FeedService
  -> FeedRegistry.loadPage(request)
  -> registered activity feed (defineSqlFeed)
  -> selectActivityPage(): src/feed/feed-query.sql, repeated with a wider scan window while incomplete
  -> Database
```

Ownership:

- `src/server.ts` is the composition root. It creates the registered activity feed, one shared registry, one `FeedService` for both endpoints, and the configured optional service-auth verifier; that verifier owns one replay map shared by both endpoints. It also owns listener settings, initial readiness, and graceful shutdown.
- `src/app.ts` is the fetch-compatible boundary. It owns fixed route metadata, POST enforcement, the 64 KiB body limit, malformed JSON, routed validation messages, and bounded request metrics.
- `src/api/*` register the procedures, run generated output validation inside the error boundary, and translate expected `FeedError` values.
- `src/feed/service.ts` projects registry pages into the two public responses. `getFeed` returns the items; `getFeedSkeleton` flattens them with `skeletonSubjects` from `src/feed/items.ts`. It does not own dispatch, cursor, or pagination policy.
- `src/feed/registry.ts` owns `feedId` dispatch and feed/params compatibility checks.
- `src/feed/sql-feed.ts` owns parameter parsing and normalization calls, feed-scoped cursor decoding and encoding, database timing, and result metrics around a feed's `select` function.
- `src/feed/query.ts` registers the activity feed and owns its generated parameter parsing, fixed SQL bind order, SQL-row-to-item mapping with explicit row invariants, and the scan-window retry.
- `src/feed/feed-query.sql` owns eligibility, ordering, keyset pagination, burst detection, audio grouping, and the `complete` flag.
- `src/feed/validation.ts` owns activity parameter normalization and limits. `src/auth/input.ts` binds the verified viewer to the request.
- `src/database.ts` is the only PostgreSQL pool owner and runs the readiness checks.
- `src/metrics.ts` owns an isolated Prometheus registry with bounded labels.

## Test seams

Test at the narrowest owner:

- app tests fake `FeedReader` and `FeedSkeletonReader`;
- service tests fake `FeedPageLoader`;
- registry tests fake registered feeds and assert dispatch invariants;
- generic SQL-feed tests fake the feed's `select` and assert parsing, cursor, timing, and metrics policy;
- activity-feed query tests fake the query executor and assert bind order, row mapping, invariants, and the retry;
- Lexicon tests inspect committed JSON and generated parsers;
- PostgreSQL integration tests own SQL, schema, selection, burst, audio, and pagination behavior. They page the real feed and compare it with the in-memory model in `test/support/feed-model.ts`, so a rule change needs both implementations updated.

## Release workflow

Add a Changeset when a pull request affects application behavior, runtime configuration, the public contract, supported runtime versions, service deployment, or operator procedures. This includes changes to feed selection, filtering, pagination, grouping, request parameters, responses, and public errors. Do not add a Changeset for local development tools, tests, behavior-preserving internal refactors, documentation-only corrections, or repository and CI maintenance that does not affect the service or its operators. CI does not infer semantic release impact; contributors and reviewers own this decision. When a pull request does include a Changeset fragment, CI validates it with `changeset status` so malformed release metadata cannot reach `main`.

Changesets creates or updates the `changeset-release/main` Release pull request with `GITHUB_TOKEN`. Current GitHub behavior creates its CI runs in an approval-required state. A maintainer must approve those runs and wait for the full PostgreSQL-backed CI suite before merging. The release workflow then validates the exact merged commit before creating the private package's Git tag and GitHub Release. It does not publish to npm or deploy the service. See `docs/RELEASING.md` for the complete flow.

## Canonical and generated files

- Project-owned `lexicons/app/gainforest/feed/*.json` is the public wire contract. There are no external Lexicon dependencies.
- `src/lexicons/` is generated and ignored. Never hand-edit or commit it.
- `src/feed/feed-query.sql` is the canonical feed statement.
- `dist/` and `coverage/` are generated and ignored.
- `npm run build` must copy the feed SQL beside `dist/feed/query.js` and smoke-load every production adapter without starting the server.

The current `@atproto/lex` generator emits explicit `l.typedObject<T>` and `l.record<Key, T>` calls whose optional fields are incompatible with this repository's `exactOptionalPropertyTypes: true`. `npm run codegen` therefore runs `scripts/fix-generated-feed-defs.mjs`, which removes only those explicit schema generics from ignored generated definitions. It does not change Lexicon JSON or runtime validators. Keep the workaround narrow. Remove the script and package-script hook only after an upstream generator version supports exact optional properties and `npm run check`, parser contract tests, and `npm run build` pass without it.

A request, response, item, or public-error change normally requires coordinated updates to Lexicon JSON, domain types, service behavior, tests, README, and the Lexicon descriptions. A new public error name also goes into `FeedErrorCode`, both procedures' Lexicon `errors` lists in the same order (a test compares them), and the README's error list. A schema-dependent change normally requires SQL, bind mapping, integration tests, the model in `test/support/feed-model.ts`, and `docs/database-contract.md`.

## Feed invariants

Preserve these unless the public contract is intentionally revised and documented:

- Both procedures accept the same `{ feedId, params?, limit?, cursor? }` wrapper. `limit` and `cursor` are generic top-level pagination controls; `params` contains only algorithm-specific values. The public params union remains open for future feeds. Runtime dispatch rejects an unregistered `feedId` with `UnsupportedFeed`. The activity feed treats missing params as its defaults (`filter` `all`, `following` false) and rejects a mismatched params discriminator with `InvalidRequest` before querying. A registered feed without `defaultParams` requires its params.
- Params are `filter` (`all`, `project`, `observation`, `organization`, `post`, `audio`; default `all`), `following` (default false), and `viewerDid`. The anonymous global feed needs no viewer. `following` needs one: anonymous requests must supply `viewerDid`; authenticated requests use the verified service-auth issuer, and a supplied value must exactly equal it. There is no caller-supplied author override or body-based override of authenticated identity.
- Authenticated tokens must carry a non-empty string `jti` of 1–256 UTF-8 bytes. After successful signature and exact `lxm` verification, each issuer-and-`jti` pair is consumed once in the shared process-local replay map, with a maximum of 512 live entries per verified issuer and 4,096 live entries total. Expired entries are purged without evicting live entries; a live full issuer quota or global map fails closed with HTTP 503. The map is cleared on restart and is not replica-global. Downstream failures do not restore a consumed token.
- `limit` counts feed items, 1 through 50, default 20. A burst or an audio day is one item. A skeleton page can hold up to 20 entries per grouped item.
- Selection reads only `validation_status = 'valid'` rows with a non-null `record_created_at`, the rows Hyperindex's typed GraphQL collections return and the materialization of the record's own `createdAt`. Do not read `json->>'createdAt'` or `indexed_at` for ordering.
- Every read of `record` in the statement, including audio group totals and the emitted-group check, also requires `record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'`. `createdAt` is client-declared: a year-10000 row cannot be formatted as a datetime and would fail every page, and a far-future row would stay on top. Write the bounds as literals in each place, not through a CTE, so the planner keeps reading the timeline index in order.
- Selected kinds: projects (`org.hypercerts.collection` typed `project` or `Project`), observations (`app.gainforest.dwc.occurrence`), organizations (`app.certified.actor.organization`, all of them), posts (`app.gainforest.feed.post` with no `reply` and no `community-event` tag), reposts (`app.gainforest.feed.repost`, only in the `all` filter, only while the subject exists, is valid, is owned by another account, and would itself be a feed record: an observation, a project typed `project` or `Project`, or a top-level post with no `community-event` tag), and audio (`app.gainforest.ac.audio`). Donations and every other collection are excluded.
- Following scopes to the distinct `subject` of the viewer's valid `app.certified.graph.follow` records. Reposts are scoped to the reposter. Never fall back to the global feed for a viewer who follows nobody; return an empty page.
- Feed order is `record_created_at DESC, uri DESC`. The cursor payload is unpadded base64url JSON with exactly `{ version: 1, feedId, value: { value, uri } }`, scoped to the selected feed. It is the position of the last row the previous page consumed, and the next page selects rows strictly after it. A burst consumes all of its members, so its cursor is the oldest member. Ordering, formatting, tie-break, and cursor payload are one contract.
- **A burst never splits across pages and no row repeats.** A run is two or more adjacent observations by one account with no gap over 12 hours (a gap of exactly 12 hours joins). "Adjacent" is adjacency in the merged feed order of the active filter: any other selected row between them ends the run, including another kind or another account's observation. A bioacoustic sighting (a valid `gainforestBioacoustics` sidecar whose source audio is in `associatedMedia`) never joins a burst. A run of one stays a `recordItem`. A burst carries its exact `total`, `from`, `to`, and up to 20 sample URIs, newest first.
- Audio groups follow the app's upload days: by (owner, folder, UTC day of `record_created_at`). The folder is `deploymentRef` when it is an AT-URI, and its owner is the account in that AT-URI when it is a DID, whoever stored the recording. Without a folder, or when the AT-URI names a handle, the recording's own account owns it. `audioItem.did` is the owner and the `following` scope applies to it. The UTC day is a deliberate difference from the app, which takes the first ten characters of the `createdAt` string. Only the newest recording takes part in the feed order, so a group is never repeated by a later page. `total` and samples come from every valid recording of the group, in any repo. The three `audio_key` expressions in the SQL must stay identical, and so must the model's `audioKey`.
- The statement reads at most `scan_rows` rows of the merged order and reports `complete = false` when a long run or an unseen audio group could change the page. `selectActivityPage` then repeats it with the next window (512, 8,192, 131,072, 2,097,152) and fails with the typed `ScanLimitExceeded` error (HTTP 422, not retryable) rather than return a page that could split a burst or lose a group. A statement timeout (SQLSTATE 57014) on any window after the first is the same condition and maps to the same error; on the first window it is an outage and stays a plain failure (`InternalError`). The windows are an internal option of `createActivityFeed` (`scanRowAttempts`), not a request parameter; tests use tiny windows to force the retry path. Keep the reasoning in the SQL comments true: kinds other than observations contribute at most `limit + 1` rows because each row is its own item.
- Keep the audio group totals a separate CTE joined by item number, not a `LEFT JOIN LATERAL` with an `ON` condition: the lateral form made PostgreSQL run the statement about ten times slower on a page of observations. Keep the emitted-group check inside its `CASE` on the cursor's UTC day, or PostgreSQL hashes every recording above the cursor.
- `repostItem` points at the repost record and names the subject. `cid` is optional on `recordItem` and `repostItem`: Hyperindex stores `''` for records whose event carried none, and one such row must not fail a page. `recordItem` for an observation, project, organization, or post names the record. No item carries display fields.
- Results are mutable current state, not snapshots across requests or an event log.

## Database and operational safety

Hyperindex owns `record`, its migrations, and its indexes. This repository must not apply migrations, create indexes, or write rows. Parameterize every caller-controlled SQL value. Index changes belong in Hyperindex and require production-shaped `EXPLAIN (ANALYZE, BUFFERS)` evidence; propose them in `docs/database-contract.md`.

Use a deployment role with `SELECT` on `record` only. `default_transaction_read_only=on` is defense in depth, not a replacement for grants.

`GET /ready` checks reachability, PostgreSQL 16 safe JSON input validation, read-only session state, and read access to the `record` columns the feed uses. It intentionally does not verify migration history, indexes, or ingestion freshness. `GET /health` is process liveness only.

`REQUEST_TIMEOUT_MS` bounds receiving a request, not total handler/query duration. Pool acquisition and statement timeouts are separate. A page can run the statement more than once; the statement timeout applies to each run.

Keep errors actionable and stable without exposing SQL, credentials, contents, internal causes, or stacks. Never use DIDs, AT-URIs, CIDs, cursors, or record values as metric labels.

Rate limiting belongs at the gateway. Keep `/health` and `/ready` private.

## Exclusions

Do not add ingestion, writes, stronger authentication modes, feed-result caching across requests, immutable history, Hyperindex/PDS/AppView API calls, blob downloads/proxying, record hydration, display fields in feed items, moderation or pin handling, preference persistence, or migrations/indexes. Service-auth verification is limited to the maintained AT Protocol verifier and the bounded DID-resolution boundary described above; retain only bounded, process-local replay-protection state through the JWT `jti`, and never log authorization credentials, JWTs, or claims.

## Change checklist

1. Inspect branch and working tree; preserve unrelated or in-flight changes.
2. Change only the owning layer and coupled contracts.
3. Add focused tests. SQL behavior requires PostgreSQL integration coverage and a matching change to the in-memory model.
4. Update Lexicons and documentation for public behavior changes.
5. Add a Changeset when the change has release impact under the release workflow policy.
6. Run `npm run check`, `npm test`, `npm run build`, and `git diff --check`.
7. Run integration tests only with an explicitly selected disposable PostgreSQL database.
8. Report commands, failures, and unavailable validation.
