# GainForest Feed Service agent guide

## Read this first

This repository is a standalone, read-only TypeScript service exposing two POST procedures with optional AT Protocol service authentication:

```text
app.gainforest.feed.getFeed
app.gainforest.feed.getFeedSkeleton
```

**`getFeed` returns references and selection metadata, not records.** Its items are AT-URIs, CIDs, account DIDs, timestamps, and group sizes and samples (a group card lists up to 20 sample URIs). It never returns titles, text, images, or profile data. GainForest hydrates the referenced records itself through Hyperindex GraphQL. `getFeedSkeleton` builds the same pages and returns the same cursor, flattened to AT-URIs, with every row a group covers. Keep that statement in the README, the Lexicon descriptions, and here whenever the contract changes.

Hyperindex is the database owner. The service reads its current PostgreSQL `record` table directly. It does not ingest, write records, own migrations or indexes, cache feed results across requests, call Hyperindex/PDS/AppView APIs, download blobs, hydrate records, or provide immutable history. Optional service auth verifies the issuer's `#atproto` signing key, audience, expiry, endpoint binding, and DID document over a bounded secure resolver. The activity feed does not use the verified issuer: every caller gets the same page, and the verifier stays for the planned following feed. It retains only bounded, process-local replay-protection state through the JWT `jti`; that state is not a feed-result cache.

Use **npm**, not pnpm. `package-lock.json` is authoritative. Node.js 22.19+ is supported; CI and Docker use Node.js 24. PostgreSQL 16+ is required.

Before changing feed behavior, read together:

- `src/feed/feed-query.sql` — selection, ordering, the row columns, and keyset pagination: a plain read of the next rows, with no grouping
- `src/feed/page-builder.ts` — how rows fold into cards: groups, the 12-hour rule, the minimum group size, the stop rule, `more`, and what a page holds
- `src/feed/query.ts` — the registered activity feed, fixed SQL bind order, the batch loop and its row budget, and row mapping
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
  -> selectActivityPage(): batches of src/feed/feed-query.sql rows, folded by PageBuilder
  -> Database
```

Ownership:

- `src/server.ts` is the composition root. It creates the registered activity feed, one shared registry, one `FeedService` for both endpoints, and the configured optional service-auth verifier; that verifier owns one replay map shared by both endpoints. It also owns listener settings, initial readiness, and graceful shutdown.
- `src/app.ts` is the fetch-compatible boundary. It owns fixed route metadata, POST enforcement, the 64 KiB body limit, malformed JSON, routed validation messages, and bounded request metrics.
- `src/api/*` register the procedures, run generated output validation inside the error boundary, and translate expected `FeedError` values.
- `src/feed/service.ts` projects registry pages into the two public responses. `getFeed` returns the items; `getFeedSkeleton` returns the page's `uris`, every row the page consumed. It does not own dispatch, cursor, or pagination policy.
- `src/feed/registry.ts` owns `feedId` dispatch and feed/params compatibility checks.
- `src/feed/sql-feed.ts` owns parameter parsing and normalization calls, feed-scoped cursor decoding and encoding, database timing, and result metrics around a feed's `select` function.
- `src/feed/query.ts` registers the activity feed and owns its generated parameter parsing, fixed SQL bind order, the batch loop with its two named constants (`BATCH_ROWS` 500 and `REQUEST_ROWS` 5,000), and SQL-row-to-`FeedRow` mapping with explicit row invariants.
- `src/feed/page-builder.ts` is pure: it folds `FeedRow`s into cards and builds the page's items, their URIs, and the next position. It owns the group keys, the 12-hour rule, the minimum group size, the stop rule, and `more`.
- `src/feed/feed-query.sql` owns eligibility, ordering, keyset pagination, and the columns of a row (the audio owner and folder, the bioacoustic flag, the repost subject). It does no grouping.
- `src/feed/validation.ts` owns activity parameter normalization and limits.
- `src/database.ts` is the only PostgreSQL pool owner and runs the readiness checks.
- `src/metrics.ts` owns an isolated Prometheus registry with bounded labels.

## Test seams

Test at the narrowest owner:

- app tests fake `FeedReader` and `FeedSkeletonReader`;
- service tests fake `FeedPageLoader`;
- registry tests fake registered feeds and assert dispatch invariants;
- generic SQL-feed tests fake the feed's `select` and assert parsing, cursor, timing, and metrics policy;
- page-builder tests feed rows to `PageBuilder` and assert grouping, the gap rule, the stop rule, `more`, and item shapes;
- activity-feed query tests fake the query executor and assert bind order, the batch loop (statement count, budget, cursor), row mapping, and invariants;
- Lexicon tests inspect committed JSON and generated parsers;
- PostgreSQL integration tests own SQL, schema, selection, grouping, and pagination behavior. They page the real feed and compare it page by page, with items, cursor, skeleton, and statement count, against the in-memory model in `test/support/feed-model.ts`, so a rule change needs both implementations updated.

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

- Both procedures accept the same `{ feedId, params?, limit?, cursor? }` wrapper. `limit` and `cursor` are generic top-level pagination controls; `params` contains only algorithm-specific values. The public params union remains open for future feeds. Runtime dispatch rejects an unregistered `feedId` with `UnsupportedFeed`. The activity feed treats missing params as its default (`filter` `all`) and rejects a mismatched params discriminator with `InvalidRequest` before querying. A registered feed without `defaultParams` requires its params.
- The only param is `filter` (`all`, `project`, `observation`, `organization`, `post`, `audio`; default `all`). **The activity feed does not depend on the caller:** the same request returns the same page whoever sends it, with or without a service-auth token, and nothing in the body or the token changes which records are selected. A property the Lexicon does not define, such as `following` or `viewerDid`, is ignored, not an error: the Lexicon object is open and `parseActivityFeedParams` keeps only `filter`. There is no caller-supplied author override. A token that is supplied is still verified, and an invalid one is a 401, never an anonymous request.
- Authenticated tokens must carry a non-empty string `jti` of 1–256 UTF-8 bytes. After successful signature and exact `lxm` verification, each issuer-and-`jti` pair is consumed once in the shared process-local replay map, with a maximum of 512 live entries per verified issuer and 4,096 live entries total. Expired entries are purged without evicting live entries; a live full issuer quota or global map fails closed with HTTP 503. The map is cleared on restart and is not replica-global. Downstream failures do not restore a consumed token.
- `limit` counts cards, 1 through 50, default 20. A group is one card while the page is built, and a group that ends with fewer than `MIN_GROUP_ROWS` (3) rows is returned as separate records, so a page holds between `limit` and `2 × limit` items, fewer when the end of the data or the row budget ends it. A skeleton page lists every row the page consumed, up to 5,000.
- Selection reads only `validation_status = 'valid'` rows with a non-null `record_created_at`, the rows Hyperindex's typed GraphQL collections return and the materialization of the record's own `createdAt`. Do not read `json->>'createdAt'` or `indexed_at` for ordering.
- Every read of `record` in the statement also requires `record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now() + interval '5 minutes'`. `createdAt` is client-declared: a year-10000 row cannot be formatted as a datetime and would fail every page, and a far-future row would stay on top. Write the bounds as literals in each place, not through a CTE, so the planner keeps reading the timeline index in order.
- Selected kinds: projects (`org.hypercerts.collection` typed `project` or `Project`), observations (`app.gainforest.dwc.occurrence`), organizations (`app.certified.actor.organization`, all of them), posts (`app.gainforest.feed.post` with no `reply` and no `community-event` tag), reposts (`app.gainforest.feed.repost`, only in the `all` filter, only while the subject exists, is valid, is owned by another account, and would itself be a feed record: an observation, a project typed `project` or `Project`, or a top-level post with no `community-event` tag), and audio (`app.gainforest.ac.audio`). Donations and every other collection are excluded.
- **Planned, not built: a separate following feed.** Following is not part of `#activityFeed` and not part of this release. It is planned as its own feed id (`#followingFeed`) with its own params definition in the `params` open union, and a follow-driven query that starts from the followed accounts and reads the author index (`idx_record_timeline_author_collection_created`) instead of walking each collection. Audio ownership through the recorder folder is still to be handled for it: a recording's owner is the folder's owner, not the account that stored it. Do not add a `following` param or a viewer to `#activityFeed`; the feed statement reads no follow record.
- Feed order is `record_created_at DESC, uri DESC`. The cursor payload is unpadded base64url JSON with exactly `{ version: 3, feedId, value: { value, uri } }`, scoped to the selected feed. It is the position of the last row the previous page consumed, and the next page selects rows strictly after it. It carries no string a record controls, so no record can make a cursor outgrow the 4,096 characters the response allows. The cursor is an unsigned token held by the client: the service trusts it only to position that client's own page. A `value` that RFC 3339 allows but PostgreSQL cannot cast (an impossible day such as 2026-02-30, year 0000, a UTC offset beyond ±15:59) is rejected when the cursor is decoded, as `InvalidCursor`, never as a database error. An older cursor version (1 and 2) is rejected with `InvalidCursor`. Ordering, formatting, tie-break, and cursor payload are one contract.
- **Groups.** A group is audio keyed by (owner, folder) or observations keyed by account; reposts, posts, projects, organizations, and bioacoustic sightings (a valid `gainforestBioacoustics` sidecar whose source audio is in `associatedMedia`) never group. Other rows between a group's rows change nothing: a row joins the group's open card when it is within 12 hours of that card's oldest row so far (a gap of exactly 12 hours joins, compared to the microsecond), otherwise it starts a new card and closes the old one. The folder is `deploymentRef` when it is an AT-URI, and its owner is the account in that AT-URI when that is a valid DID (`did:method:id`, at most 2,048 characters, the shape the Lexicon's `did` format accepts), whoever stored the recording; without a folder, or when the authority is a handle or anything else that is not a valid DID, the recording's own account owns it, so `groupItem.did` is always a DID. `groupItem.deployment` names the folder only when it passes the strict `isAtUriString` test, the one the Lexicon's `format: at-uri` applies on output, and is omitted otherwise (the group still keys on the raw `deploymentRef`); one value the output check rejects would answer 500 on every `getFeed` page that holds the recording. `groupKey` is a stable hash of (kind, owner, folder): the same group has the same key on every page.
- **Pages.** The page takes `limit` cards. It stops at the first row that would start another card (rows that join an open card are always taken), at the end of the data, or after `REQUEST_ROWS` (5,000) consumed rows. Every consumed row is in exactly one item, and the cursor is the last consumed row. A card sits at its newest row. A group card of fewer than `MIN_GROUP_ROWS` (3) rows is expanded into one `recordItem` per row at that row's own position; a recording is a `recordItem` of kind `audio` and names the account that stored it. A budget stop always has a cursor (the service cannot know that no row remains, so the next page is empty when the data ended exactly there) and sets `more: true` only on a group card that a later row can still join (the group's latest card, while the page's last row is within 12 hours of the card's oldest row); no other stop sets it, and the absence of `more` does not mean a group is complete, so clients merge by `groupKey` and the 12-hour rule, never by `more`. A group whose rows continue on the next page comes back as another card with the same `groupKey`, and the client merges them by the rule in the Lexicon and the README: the later card's `to` is no more than 12 hours before the earlier card's `from`. The service keeps no state between requests.
- **Batches.** `createActivityFeed` runs `selectActivityPage`: it asks for `BATCH_ROWS` (500, one named constant in `src/feed/query.ts`) rows after the last consumed row, folds them, and repeats until the page stops, so a request runs one statement when the first batch holds the page and at most `REQUEST_ROWS / BATCH_ROWS` (10) otherwise. A short batch means the data ended. A statement timeout is a plain `InternalError`, and nothing is retried. `createActivityFeed` takes internal `batchRows` and `requestRows` options so tests can reach batching and the budget with small data sets; production uses the constants.
- Keep the statement's plan shape (the reasons are in the SQL header, and a change needs `EXPLAIN (ANALYZE, BUFFERS)` evidence on a table of production shape): the cursor as an inline predicate on `$2`/`$3`, not a CTE; every arm and the merged stream limited by `(SELECT $4)`, a number PostgreSQL cannot see, so it plans for the first tenth and keeps the ordered timeline-index scan instead of a bitmap scan and a sort of the whole collection (with a visible limit the post arm, estimated at about 9 rows where 3,000 match, read every post); the `OFFSET 0` levels that read the audio `deploymentRef` and the observation sidecar once per row; and no `json` read for a row beyond the columns it needs (the sidecar is parsed only for observations whose text mentions it). The audio owner and folder expression exists once in the SQL, in `audio_keyed`, and once in the model's `audioKey`; change the SQL and the model together.
- `repostItem` points at the repost record and names the subject. `cid` is optional on `recordItem` and `repostItem`: Hyperindex stores `''` for records whose event carried none, and one such row must not fail a page. `recordItem` for an observation, project, organization, post, or audio recording names the record. No item carries display fields.
- Results are mutable current state, not snapshots across requests or an event log.

## Database and operational safety

Hyperindex owns `record`, its migrations, and its indexes. This repository must not apply migrations, create indexes, or write rows. Parameterize every caller-controlled SQL value. Index changes belong in Hyperindex and require production-shaped `EXPLAIN (ANALYZE, BUFFERS)` evidence; propose them in `docs/database-contract.md`.

Use a deployment role with `SELECT` on `record` only. `default_transaction_read_only=on` is defense in depth, not a replacement for grants. The pool also opens every session with `jit=off` (`src/database.ts`): the statement hides its row limit from the planner, so its estimated cost grows with the table and could cross `jit_above_cost`, and JIT compilation would then add 100 to 150 ms to a statement that runs in a few milliseconds.

`GET /ready` checks reachability, PostgreSQL 16 safe JSON input validation, read-only session state, and read access to the `record` columns the feed uses. It intentionally does not verify migration history, indexes, or ingestion freshness. `GET /health` is process liveness only.

`REQUEST_TIMEOUT_MS` bounds receiving a request, not total handler/query duration. Pool acquisition and statement timeouts are separate. A request runs at most 10 statements, and the statement timeout applies to each of them.

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
