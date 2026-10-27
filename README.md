# GainForest Feed Service

A standalone, read-only TypeScript service. It reads current [Hyperindex](https://github.com/GainForest/hyperindex) PostgreSQL data and serves the GainForest activity feed and following feed over XRPC.

**`getFeed` returns references and selection metadata, not records.** Each feed item names records by AT-URI and CID, and adds the account, timestamps, and group counts the service decided. It carries no titles, text, images, or profile data. GainForest hydrates the referenced records itself, through Hyperindex's GraphQL API.

Hyperindex owns the PostgreSQL tables. The service does not ingest or change indexed data, call Hyperindex, PDS, or AppView APIs, write records, fetch blob bytes, or provide an unchangeable event history. Feed authentication is optional AT Protocol service authentication. The activity feed is the same for every caller, so a verified token changes nothing in the response. Only the following feed has a viewer: the verified caller.

## Endpoints

`GET /` returns a small JSON description of the service and lists its public XRPC procedures. It does not query the database or report service readiness. For a hostname-level `did:web` configured as `SERVICE_DID`, `GET /.well-known/did.json` publishes a DID document with a `#gainforest_feed` service entry (`GainForestFeedService`) pointing to the HTTPS origin derived from that DID. The route uses the configured DID, not the request hostname. Non-`did:web` service DIDs do not publish a document here.

Both feed endpoints are POST procedures with optional AT Protocol service authentication. They use the same `{ feedId, params?, limit?, cursor? }` request wrapper, feed-scoped cursor contract, and stable public errors. `params` contains only algorithm-specific values; pagination is generic and top-level.

```text
POST /xrpc/app.gainforest.feed.getFeed
POST /xrpc/app.gainforest.feed.getFeedSkeleton
Content-Type: application/json
```

These are app-specific XRPC procedures. They are not Bluesky's `app.bsky.feed.getFeedSkeleton` query.

The procedure and JSON-body design is intentional. A Lexicon query cannot have an input body, and Lexicon's HTTP query-parameter `params` type cannot contain references, nested objects, or the open union needed for different feed algorithms to define different parameter shapes. Procedures can have both URL parameters and a body, but splitting `feedId`, `limit`, and `cursor` into the URL while putting algorithm-specific values in the body would make one feed request harder to construct and understand. Keeping the complete request in one JSON body conforms to the Lexicon specification and gives generated clients one coherent input object. It differs only from the style guide's usual `limit` and `cursor` convention for query endpoints. This transport shape is part of the public contract and should be settled before clients adopt it, because moving fields between the body and URL later would be a breaking change.

### Request

```bash
curl -sS http://localhost:3000/xrpc/app.gainforest.feed.getFeed \
  -H 'content-type: application/json' \
  --data '{
    "feedId": "app.gainforest.feed.defs#activityFeed",
    "params": {
      "$type": "app.gainforest.feed.defs#activityFeedParams",
      "filter": "observation"
    },
    "limit": 20
  }'
```

The activity feed (`app.gainforest.feed.defs#activityFeed`) takes `app.gainforest.feed.defs#activityFeedParams`:

| Param    | Default | Meaning                                                                                              |
| -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `filter` | `all`   | `all`, `project`, `observation`, `organization`, `post`, or `audio`. Reposts appear only with `all`. |

**The feed does not depend on the caller.** Every caller gets the same page for the same request, so the feed needs no login and a verified token changes nothing in the response. A service caller may still add `-H 'authorization: Bearer <service-auth-jwt>'`. The service verifies it: the token must target the bare DID configured as `SERVICE_DID`, carry the exact endpoint NSID in `lxm`, and be signed by the issuer's `#atproto` key. The verified caller matters to one feed only, the [following feed](#following-feed). Invalid supplied authorization returns 401 and is never treated as anonymous.

`params` is optional for this feed. Omitting it means the default, `filter` `all`, so a request with only a `feedId` returns the global feed. `params` holds only `filter`: a property it does not define, such as `following` or `viewerDid`, is ignored, so a request that sets one gets the global feed. A mismatched `$type` returns `InvalidRequest`, while an unknown `feedId` returns `UnsupportedFeed`. The public params union is open for future feed algorithms.

`limit` counts the cards a page is built from, from 1 to 50 (default 20). A group is one card, but a group of fewer than 3 rows is returned as separate records, so a page holds between `limit` and `2 × limit` items, and fewer when the end of the data or the request's row budget ends it first (see [Groups](#groups)). Send a returned cursor back as the top-level request `cursor`, never inside `params`.

### Following feed

The following feed (`app.gainforest.feed.defs#followingFeed`) holds what the accounts a viewer follows have published: the same items, groups, pages, `limit`, and cursor format as the activity feed, restricted to the viewer's follows. It takes `app.gainforest.feed.defs#followingFeedParams`:

| Param       | Default                  | Meaning                                                                                              |
| ----------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `filter`    | `all`                    | `all`, `project`, `observation`, `organization`, `post`, or `audio`. Reposts appear only with `all`. |
| `viewerDid` | the authenticated caller | The account whose follows scope the feed. Required for an anonymous request.                         |

```bash
curl -sS http://localhost:3000/xrpc/app.gainforest.feed.getFeed \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <service-auth-jwt>' \
  --data '{ "feedId": "app.gainforest.feed.defs#followingFeed", "limit": 20 }'
```

- **The viewer.** An authenticated request is for its verified caller: `params` and `viewerDid` may be left out, and a `viewerDid` that names anyone else is rejected with `InvalidRequest`. An anonymous request has nobody to default to: it must send `params` with the `followingFeedParams` `$type` and a `viewerDid` (`InvalidRequest` otherwise). Anyone can therefore ask for any account's following feed anonymously. That is intended: follow records and the records they lead to are public, so the feed shows nothing the repositories do not already show.
- **Follows.** The viewer follows the subjects of their valid `app.certified.graph.follow` records. A viewer who follows nobody gets an empty page, and the service reads no collection for it. A viewer who follows more than 500 accounts gets the 500 most recently followed (an account followed twice counts once), which bounds what a statement reads for the followed accounts. It does not bound reading the follow records themselves, which is linear in how many the viewer has: about 100 ms per statement at 30,000 follow records and 200 ms at 100,000. An anonymous caller can name any account as the viewer, so that cost follows the largest follower.
- **What is in it.** The selection rules are the activity feed's (valid rows, the date range, projects, top-level posts, reposts with a valid subject of another account, observations, organizations), for the accounts the viewer follows. A repost is the reposting account's. A recording belongs to the owner of its recorder folder, not to the account that stored it: it is in the feed when a followed account owns the folder, and then it is shown with the owner's group. So a recording another account stored in a followed account's folder is included, and a recording a followed account stored in a folder someone else owns is not. A followed account's own recordings, those without a folder, in its own folder, or in a folder named by a handle or anything else that is not a valid DID, are in the feed as for the activity feed. A recording that another account stored is found through the deployment record that is its folder, so it needs that record to exist and to be valid.
- **Cursors** belong to the feed that issued them: `#followingFeed` rejects an activity cursor, and `#activityFeed` a following cursor, with `InvalidCursor`.

### getFeed response

```json
{
  "feed": [
    {
      "$type": "app.gainforest.feed.defs#recordItem",
      "kind": "post",
      "uri": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/app.gainforest.feed.post/3kpn",
      "cid": "bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u",
      "did": "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
      "createdAt": "2026-07-21T10:00:00.000000Z"
    },
    {
      "$type": "app.gainforest.feed.defs#groupItem",
      "kind": "observation",
      "did": "did:plc:ar7c4by46qjdydhdevvrndac",
      "groupKey": "dM_zftW-fmKtVG8r55HKNZ",
      "total": 214,
      "from": "2026-07-21T07:12:09.114000Z",
      "to": "2026-07-21T09:48:31.502000Z",
      "subjects": ["at://did:plc:ar7c4by46qjdydhdevvrndac/app.gainforest.dwc.occurrence/3kpm"]
    }
  ],
  "cursor": "eyJ2ZXJzaW9uIjozLCJmZWVkSWQiOi..."
}
```

The `feed` array is an open union. Clients must tolerate item types they do not know. The current items are:

- `recordItem`: one `project`, `observation`, `organization`, `post`, or `audio` record (`kind`, `uri`, `did`, `createdAt`, and the `cid` when Hyperindex has stored one). An observation or a recording is a `recordItem` when it is not part of a group.
- `repostItem`: an `app.gainforest.feed.repost` record (`uri`, `did`, `createdAt`, and the `cid` when stored) and the AT-URI of the record it reposts (`subject`). The item is ordered by the repost's time.
- `groupItem`: at least 3 observations by one account (`kind` `observation`) or recordings in one recorder folder (`kind` `audio`), folded into one card. It carries `kind`, the group's owner (`did`: the account of the observations, or the account in the folder's AT-URI, or the recording's own account when it has no folder), the optional `deployment` AT-URI of the folder (audio only, omitted when the recording's `deploymentRef` is not a valid AT-URI), the stable `groupKey`, `total` (the rows in this card), the oldest and newest `createdAt` (`from`, `to`), up to 20 sample URIs in `subjects`, newest first, and `more` when the request's row budget ended the page while a later row could still join this card (see [Groups](#groups)).

Items are ordered newest first by the record's own `createdAt`, as Hyperindex materializes it in `record_created_at`, then by URI. A group card takes the time of its newest row (`to`).

### Groups

The page folds rows into cards the way the GainForest app does on the client, moved into the service and made independent of the rows around a group:

- **A group** is the observations of one account, or the recordings of one owner and recorder folder. Bioacoustic sightings, reposts, posts, projects, and organizations never group.
- **A row joins its group's open card** when it is no more than 12 hours older than the card's oldest row so far. Rows of other kinds, accounts, or folders between them do not matter, so two recorders that upload at the same time give one card each. A row further away starts a new card, and the old one is closed.
- **A group needs 3 rows.** A card of one or two rows is returned as separate records, each at the position of its own row.
- **A card sits at its newest row**, and every consumed row is in exactly one item.
- **`limit` counts cards** while the page is built. The page takes rows until the next one would start a card beyond `limit`; rows that join an open card are always taken. A page holds between `limit` and `2 × limit` items.
- **A request consumes at most 5,000 rows**, and reads them in statements of 500, so it runs at most 10 statements. A page that reaches the 5,000 rows ends there, always has a cursor, and says `more: true` on a group card that a later row can still join: its group's latest card, when the page's last row is within 12 hours of the card's oldest row.

The cursor is the last consumed row and nothing else. The service keeps no state between requests, so a group whose rows continue on the next page comes back there as another card with **the same `groupKey`**. `groupKey` is a stable hash of the group's kind, owner, and folder, so it is the same on every page and in every request. Treat it as opaque; two cards of one group, split by a gap of more than 12 hours, share it too.

**Clients merge cards across pages.** Keep the last card shown for each `groupKey`. When a later card has the same `groupKey` and its `to` is no more than 12 hours before that card's `from`, merge it into that card: add its `total`, take its `from` and its `more`, and append its `subjects`. Otherwise it is a new card, and it becomes the last card for that key. Most merging happens inside the service, so the rule matters only at page edges and for groups longer than the row budget. **The absence of `more` does not mean that a group is complete:** a group also continues after a page that ended for another reason, so always merge by `groupKey` and the 12-hour rule, never by `more`. A continuation of fewer than 3 rows comes back as separate records, which are not merged.

### getFeedSkeleton response

```json
{
  "feed": [
    { "subject": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/app.gainforest.feed.post/3kpn" }
  ],
  "cursor": "eyJ2ZXJzaW9uIjozLCJmZWVkSWQiOi..."
}
```

`getFeedSkeleton` builds the same pages and returns the same cursor as `getFeed`, flattened to AT-URIs in item order: the order of the items `getFeed` returns, with all rows of a group listed together, newest first, at the group's position. A repost yields the repost record's URI, and a group yields the URI of **every** row it covers. The skeleton therefore lists each row the page consumed exactly once, but it is not a feed-ordered sequence: a group's later members come before the rows that lie between them in the feed. A skeleton page can therefore hold many more entries than its `limit`, up to the 5,000 rows one request consumes.

#### What the service does not do

The service never returns record content and never contacts Hyperindex's API, a PDS, or an AppView. Moderation, pins, image URLs, profile data, and read-your-writes stay in the GainForest app.

The `recordItem` for an organization is every valid `app.certified.actor.organization` record. The app applies its own ledger on top. Donations are not part of this feed.

## Request flow

```mermaid
sequenceDiagram
    actor Client
    participant HTTP as HTTP App
    participant XRPC as XRPC Handler
    participant Service as FeedService
    participant Registry as Feed Registry
    participant Feed as Activity or Following Feed (SQL)
    participant DB as Hyperindex PostgreSQL

    Client->>HTTP: POST feed procedure + optional Bearer JWT
    HTTP->>XRPC: Bounded, validated JSON
    XRPC->>XRPC: Verify audience, expiry, lxm, #atproto signature
    XRPC->>XRPC: Validate and consume issuer-scoped jti
    XRPC->>Service: Endpoint input (for the following feed, the verified caller becomes its viewer)
    Service->>Registry: Load page
    Registry->>Feed: Dispatch feedId, params, and pagination
    Feed->>DB: Batches of 500 rows, at most 10 statements
    DB-->>Feed: Rows: kind, uri, cid, account, time, folder, sighting flag
    Feed->>Feed: Fold rows into cards (groups, limit, row budget)
    Feed-->>Registry: Selected items and feed-scoped cursor
    Registry-->>Service: Page
    Service-->>XRPC: References and metadata (getFeed) or flattened URIs (getFeedSkeleton)
    XRPC-->>HTTP: Procedure response
    HTTP-->>Client: JSON response
```

## Request behavior

- Malformed JSON, params that do not match the selected feed, or structurally invalid top-level pagination return HTTP 400 with `InvalidRequest`. A `limit` below 1 is rejected by the Lexicon schema and returns HTTP 400 with `InvalidRequest`. Semantically invalid parameters (an unknown `filter`, a `limit` above 50) return HTTP 422 with the same generic error name and an actionable message. An unregistered `feedId` returns `UnsupportedFeed`. These never become internal server errors.
- A present `Authorization` header is always verified. Malformed, expired, not-yet-valid, wrong-audience, wrong-endpoint, unresolved-issuer, or incorrectly signed service JWTs return HTTP 401; the request is never retried anonymously. DID documents are resolved over bounded HTTPS-only requests with direct public-address pinning; `did:web` redirects and private, loopback, link-local, reserved, and special-use destinations are rejected.
- Service-auth JWTs must include a signed, non-empty `jti` no larger than 256 UTF-8 bytes. After signature, audience, expiry, and exact endpoint checks succeed, the service accepts each issuer-and-`jti` pair once. A token is consumed before the downstream feed request runs, so retries require a fresh token even when feed generation fails. Replay state is bounded to 512 live entries per verified issuer and 4,096 live entries total, local to the running process, cleared on restart, and not shared between replicas; a full live issuer quota or global store returns HTTP 503 until entries expire. Anonymous requests remain unaffected because they do not use service-auth replay state.

**Accepted pre-launch risk:** Eight verified issuers can each consume 512 live entries and fill the 4,096-entry process-wide store. While it is full, fresh valid tokens from unrelated issuers receive HTTP 503 until entries expire. The per-issuer cap does not prevent this cross-issuer denial of authenticated requests. Keep one-use tokens and fail-closed behavior for now; revisit capacity and abuse controls before relying on authenticated feed availability.

## Selection, ordering, and current-state behavior

[`docs/database-contract.md`](docs/database-contract.md) is the full contract. In short:

- The feed reads only rows Hyperindex marks `validation_status = 'valid'`, the rows its typed GraphQL collections return. It excludes rows whose `createdAt` Hyperindex could not parse, and rows whose `createdAt` is before 1970 or more than five minutes in the future. `createdAt` is client-declared: a year-10000 record cannot be formatted as a datetime, and a record dated 2099 would otherwise sit at the top of the feed for good.
- Projects are `org.hypercerts.collection` records typed `project` or `Project`. Observations are `app.gainforest.dwc.occurrence`. Organizations are `app.certified.actor.organization`. Posts are top-level `app.gainforest.feed.post` records without a `community-event` tag. Reposts are `app.gainforest.feed.repost` records whose subject still exists as a valid observation, as a project typed `project` or `Project`, or as a top-level post without a `community-event` tag, owned by another account. Audio is `app.gainforest.ac.audio`.
- **Grouping ignores the rows around a group.** Observations of one account and recordings of one owner and folder fold into one card whatever other rows lie between them, as long as each is within 12 hours of the group's previous row. A group of fewer than 3 rows is returned as separate records. Bioacoustic sightings never group.
- **The following feed starts from the followed accounts.** It keeps the same rules for what a record is, and adds the follow scope: a record of a followed account, a repost by one, and a recording whose folder a followed account owns. A recording that another account stored counts only through the folder's own record: the folder's `app.gainforest.ac.deployment` record has to exist and be valid, which the activity feed does not ask.
- Audio groups are keyed by owner and folder. A recording that names a recorder folder (`deploymentRef` is an AT-URI) belongs to that folder, and the account in the folder's AT-URI owns the group, whoever stored the recording. A recording without a folder, or whose folder names a handle (or anything else that is not a valid DID) instead of a DID, belongs to its own account. A recording that is not part of a group is a `recordItem` of kind `audio` and names the account that stored it.
- The cursor is unpadded base64url JSON with a version, scoped to the feed. It points at the last row the previous page consumed and holds nothing a record controls. It is an unsigned token held by the client: the service uses it only to position that client's own page. A cursor whose timestamp is not a real date, or that an earlier version issued, is rejected with `InvalidCursor`: request the first page again.
- Results are mutable current state, not a snapshot across requests.

### Pagination and database reads

- A page is built from batches of 500 rows, newest first, after the cursor. Most requests need one statement. A request that folds a long dump needs one per 500 rows it consumes, never more than 10, so it never consumes more than 5,000 rows. A statement is a plain read of those rows; grouping happens in the service.
- A statement that exceeds the database statement timeout (`DATABASE_STATEMENT_TIMEOUT_MS`) is an outage and returns `InternalError`. A request is bounded by 10 of them.
- The following feed's statement starts from the viewer's followed accounts and reads each account's records through Hyperindex's author index, so what it costs depends on how many accounts the viewer follows and how much they stored, not on the size of the collections. Recordings are the exception, because Hyperindex has no index on `deploymentRef`. Recordings that other accounts stored in a followed account's folder are found by walking the audio collection, only for a viewer whose follows own a folder. A followed account's own recordings are read in full on every statement, about 2 to 4 microseconds each: nothing for an account with hundreds, noticeable for one with tens of thousands, an organization with a large archive of its own recordings included. The measurements, the plan, and the index to propose to the Hyperindex owners are in [`docs/database-contract.md`](docs/database-contract.md#the-following-feed).
- The service never makes extra queries to hydrate or refill items.
- Each page is a separate database read. Changes made between requests may appear on later pages.

## Runtime configuration

For local development, copy `.env.example` to `.env`. For deployment, copy its values into the deployment's variable configuration. The process can load a local `.env`, but it never replaces variables already set in the environment.

| Variable                         | Required |   Default | Purpose                                                                                |
| -------------------------------- | -------: | --------: | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   |      yes |           | Dedicated read-only Postgres URL for the Hyperindex database                           |
| `SERVICE_DID`                    |      yes |           | DID identifying this service and required as the service-auth JWT audience             |
| `SERVICE_AUTH_MAX_AGE_SECONDS`   |       no |     `300` | Maximum service-auth JWT age; bounded from 1 through 3600 seconds                      |
| `DID_RESOLUTION_TIMEOUT_MS`      |       no |    `2000` | Total timeout for one HTTPS DID-document resolution; bounded from 100 through 60000 ms |
| `PORT`                           |       no |    `3000` | HTTP listen port                                                                       |
| `HOST`                           |       no | `0.0.0.0` | Public HTTP listen interface                                                           |
| `METRICS_HOST`                   |       no | `0.0.0.0` | Private metrics listen interface; used only when `METRICS_PORT` is set                 |
| `METRICS_PORT`                   |       no |  disabled | Enables the private `GET /metrics` listener on this port; must differ from `PORT`      |
| `LOG_LEVEL`                      |       no |    `info` | Pino log level                                                                         |
| `DATABASE_MAX_CONNECTIONS`       |       no |       `5` | Maximum pool size, capped at 20; the pool keeps one connection warm                    |
| `DATABASE_IDLE_TIMEOUT_MS`       |       no |   `60000` | Time before idle connections above the one-connection minimum are closed               |
| `DATABASE_CONNECTION_TIMEOUT_MS` |       no |    `2000` | Pool acquisition timeout                                                               |
| `DATABASE_STATEMENT_TIMEOUT_MS`  |       no |    `5000` | PostgreSQL statement timeout                                                           |
| `REQUEST_TIMEOUT_MS`             |       no |   `10000` | Maximum time allowed to receive an HTTP request; not a handler or database deadline    |
| `GRACEFUL_SHUTDOWN_MS`           |       no |   `10000` | Shutdown drain timeout                                                                 |

For example, set `SERVICE_DID=did:web:feed.gainforest.example` only when `https://feed.gainforest.example` routes to this service; clients can discover its XRPC endpoint using `did:web:feed.gainforest.example#gainforest_feed`. This service does not publish a signing key: it verifies callers using their own DID documents. The DID service entry is for discovery and does not change JWT audience validation.

Service-auth audience verification currently accepts only the bare `SERVICE_DID`. [AT Protocol Proposal 0014](https://github.com/bluesky-social/proposals/blob/main/0014-service-auth-revised/README.md) defines the combined `did#serviceId` service reference, but the reference PDS currently emits the bare-DID service-auth audience and `@atproto/lex-server` does not yet support the combined audience form. This is separate from JWT `jti` replay protection, which this service validates and consumes once per issuer in its bounded process-local replay state. Clients may still use a combined service reference for PDS proxy routing. When upstream support and PDS behavior are ready, update the verifier to accept an explicit allowlist of both audience forms.

## Database access

Use a dedicated login that has only `SELECT` access to `record`. The service also sets `default_transaction_read_only=on` for every connection in the pool, but database grants are still the main security boundary. It sets `jit=off` as well: the feed statement runs in a few milliseconds, and PostgreSQL's just-in-time compilation would only add latency once the table is large enough for the planner's cost estimate to cross `jit_above_cost`.

Each service replica has its own limited in-process pool. When planning database connections, allow for `replica count × DATABASE_MAX_CONNECTIONS`. Use an external pooler if many replicas share a PostgreSQL server with few available connections.

Example operator setup:

```sql
CREATE ROLE gainforest_feed_reader LOGIN PASSWORD '<managed-secret>';
GRANT CONNECT ON DATABASE hyperindex TO gainforest_feed_reader;
GRANT USAGE ON SCHEMA public TO gainforest_feed_reader;
GRANT SELECT ON TABLE public.record TO gainforest_feed_reader;
ALTER ROLE gainforest_feed_reader SET default_transaction_read_only = on;
```

The service has no migrations or feed tables of its own. It needs Hyperindex migration 010 (`record_created_at` and its timeline indexes, among them the author index the following feed reads), migration 012 (`validation_status`), and the `(did, collection)` index of migration 001. `/ready` checks that the database can be reached, PostgreSQL 16 can safely validate JSON text, the session is read-only, and the role can read the `record` columns the feed uses. It does not check migration history, indexes, or ingestion freshness. See [`docs/database-contract.md`](docs/database-contract.md) for the runtime schema contract, the indexes the feed relies on, and index proposals for the Hyperindex owners.

## Development

You need Node.js 22.19+ and PostgreSQL 16+. The minimum Node.js version matches the `undici_v8` dependency used by service authentication.

```bash
npm install
npm run lint
npm run format:check
npm run check
npm run test:unit
npm run build
```

The committed project Lexicons in `lexicons/` define the public wire contract. The generated TypeScript in `src/lexicons/` is ignored. Do not edit or commit it. The `codegen`, `check`, test, and build commands regenerate it; `npm run lint` also does so through its `prelint` hook before typed linting. `npm run lint:fix` applies ESLint autofixes, and `npm run format` formats maintained TypeScript, MJS, Markdown, YAML, project configuration, and the project-owned feed Lexicons. Generated output and release changelogs are excluded. `AGENTS.md` explains a small, focused workaround for the current `@atproto/lex` generator output that runs after codegen.

The feed statement is `src/feed/feed-query.sql`, a plain read of the next rows. `src/feed/query.ts` registers the activity feed and runs the loop that fetches batches until the page is built, `src/feed/page-builder.ts` folds the rows into cards, and `src/feed/registry.ts` and `src/feed/sql-feed.ts` own dispatch and shared SQL-feed policy. During development, the watcher watches the SQL along with the TypeScript source. The build copies it next to `dist/feed/query.js` before checking that the production adapters load.

### PostgreSQL integration tests

Integration tests need a PostgreSQL 16+ database that you explicitly choose and that is empty and safe to discard:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/gainforest_feed_test' \
  npm run test:integration
```

The suite creates a minimal Hyperindex `record` table if the database has none, copies it into a private schema for each test, and drops that schema afterwards. It does not drop or empty `public.record`. Never point it at a shared, staging, or production database.

To test against Hyperindex's migrated schema, use a separate disposable database with no application rows:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/hyperindex_feed_test' \
  npm run test:integration:hyperindex
```

This command needs `psql`. It checks the Hyperindex columns and indexes the service uses, then runs the behavior suite, which inserts synthetic records. It does not apply Hyperindex migrations or prove that real records have been ingested.

## Releases

Add a Changeset with `npm run changeset` when a pull request affects the service's behavior, runtime configuration, public contract, supported runtime versions, deployment, or operator procedures. Local development tools, tests, behavior-preserving internal refactors, documentation-only corrections, and repository or CI maintenance with no service or operator impact do not need one. CI allows omission but validates any included Changeset fragment before merge. GitHub creates approval-gated CI runs for the automated **Release** pull request. Maintainers approve those runs, wait for the full PostgreSQL-backed CI suite, and merge the Release pull request only after it passes. The release workflow then validates the exact merged commit and creates a Git tag and GitHub Release without publishing the private package to npm or deploying the service.

See [`docs/RELEASING.md`](docs/RELEASING.md) for the contributor and maintainer workflow.

## Deployment

```bash
docker build -t gainforest-feed-service .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgresql://...' \
  -e SERVICE_DID='did:web:feed.gainforest.example' \
  gainforest-feed-service
```

Deploy the service beside Hyperindex and use private networking for the database.

To expose metrics, set a private metrics listener separate from the public application port:

```env
METRICS_HOST=0.0.0.0
METRICS_PORT=3001
```

Configure a compatible Prometheus collector to read `http://<private-service-host>:3001/metrics`. The `GET /metrics` response uses Prometheus-compatible exposition format. The listener has no application-level authentication, so do not attach a public domain or TCP proxy to the metrics port. Each replica exposes only its current in-memory registry; the collector owns aggregation, retention, and historical data. When `METRICS_PORT` is unset or empty, the metrics listener is disabled. `/metrics` remains unavailable on the public application port. Metric names keep the `hypercerts_feed_` prefix from the service this one was forked from. The database duration histogram `hypercerts_feed_database_duration_seconds` has an `operation` label (`feed`: one whole page request of up to 10 statements; or `readiness`) and, for `feed`, a `feed` label naming the registered feed (`activity` or `following`), so the latencies of the two feeds, whose costs differ, can be told apart. The label is a closed list and never carries caller input.

Set per-IP rate limits at the gateway. The first public policy allows 60 feed requests per minute for each client IP, with a burst of 20. When a client exceeds the limit, return HTTP 429 with `Retry-After`. Keep health and readiness private and outside this public limit. Adjust the limits using measured query response time and pool saturation.

The process limits request body size, HTTP request receive time, pool size, connection wait time, SQL statement duration, and DID-document resolution time. `REQUEST_TIMEOUT_MS` is not a deadline for the whole handler or query. After a complete POST body is buffered, downstream authentication uses a fresh signal because the current `@atproto/lex-server/nodejs` adapter aborts its request signal when the body ends normally. A client disconnect after the full body is received therefore does not cancel authentication or feed work; DID resolution and database timeouts still apply. Feed procedures allow browser requests from every origin and support `POST` preflight requests with `content-type` and `authorization` headers. They do not allow credentialed CORS requests. CORS does not authenticate callers or replace gateway rate limiting. Do not add rate-limit state to this service because separate replicas would disagree. Service-auth replay state is a separate bounded, process-local safeguard; it is not a distributed rate limiter.

## Operations

- `GET /.well-known/did.json`: serves the configured hostname-level `did:web` identity and `#gainforest_feed` service entry; its endpoint comes from `SERVICE_DID`, not the request hostname.
- `GET /health`: checks only whether the process is alive.
- `GET /ready`: checks current database support, read-only state, and read access to the Hyperindex `record` columns the feed uses; the runtime schema contract is documented separately.
- Private metrics listener: when `METRICS_PORT` is set, `GET /metrics` exposes this replica's metrics in Prometheus-compatible exposition format on `METRICS_HOST:METRICS_PORT`; all other paths are rejected.
- `SIGTERM` and `SIGINT`: stop accepting requests, let current work finish, stop the optional metrics listener, and then close the database pool.

Stable public feed errors:

```text
InvalidRequest
UnsupportedFeed
InvalidCursor
InternalError
```

Feed-specific parameter failures use `InvalidRequest`; their message identifies the invalid parameter and how to correct it.

A feed statement that exceeds the database statement timeout (`DATABASE_STATEMENT_TIMEOUT_MS`, 5 seconds by default) is an outage, not a long group, and returns `InternalError`.

Public errors never show SQL, database credentials, table contents, internal causes, or stack traces.

## Boundaries

The service does not ingest data, write records, manage migrations or indexes, cache feed results across requests, call Hyperindex, PDS, or AppView APIs, download blobs, hydrate records, return display fields, apply moderation or pins, save preferences, or provide an unchangeable event history. It retains only bounded, process-local replay-protection state through the JWT `jti`; that state is not a feed-result cache. Results show Hyperindex's current, changeable data and its current freshness.
