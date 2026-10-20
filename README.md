# Hypercerts Feed Service

A standalone, read-only TypeScript service. It reads current HappyView PostgreSQL data and serves ordered Hypercerts feeds over XRPC.

HappyView owns the PostgreSQL tables. The service provides a URI-only skeleton and a hydrated feed with generic entries and feed-specific views. It does not ingest or change indexed data, call HappyView APIs, write records, fetch blob bytes, or provide an unchangeable event history. Feed authentication is optional AT Protocol service authentication; it never trusts a body viewer over the verified issuer.

## Endpoints

`GET /` returns a small JSON description of the service and lists its public XRPC procedures. It does not query the database or report service readiness. For a hostname-level `did:web` configured as `SERVICE_DID`, `GET /.well-known/did.json` publishes a DID document with a `#hypercerts_feed` service entry (`HypercertsFeedService`) pointing to the HTTPS origin derived from that DID. The route uses the configured DID, not the request hostname. Non-`did:web` service DIDs do not publish a document here.

Both feed endpoints are POST procedures with optional AT Protocol service authentication. They use the same `{ feedId, params?, limit?, cursor? }` request wrapper, feed-scoped cursor contract, and stable public errors. `params` contains only algorithm-specific values; pagination is generic and top-level. The registered Hypercerts feed requires the Hypercerts params object and discriminator. Anonymous requests must include `params.viewerDid`; authenticated callers may omit it, and the verified JWT issuer supplies the viewer. A supplied viewer DID must match the issuer:

```text
POST /xrpc/org.hypercerts.feed.getFeedSkeleton
POST /xrpc/org.hypercerts.feed.getFeed
Content-Type: application/json
```

These are app-specific XRPC procedures. They are not Bluesky's `app.bsky.feed.getFeedSkeleton` query.

The procedure and JSON-body design is intentional. A Lexicon query cannot have an input body, and Lexicon's HTTP query-parameter `params` type cannot contain references, nested objects, or the open union needed for different feed algorithms to define different parameter shapes. Procedures can have both URL parameters and a body, but splitting `feedId`, `limit`, and `cursor` into the URL while putting algorithm-specific values in the body would make one feed request harder to construct and understand. Keeping the complete request in one JSON body conforms to the Lexicon specification and gives generated clients one coherent input object. It differs only from the style guide's usual `limit` and `cursor` convention for query endpoints. This transport shape is part of the public contract and should be settled before clients adopt it, because moving fields between the body and URL later would be a breaking change.

### Request

```bash
curl -sS http://localhost:3000/xrpc/org.hypercerts.feed.getFeed \
  -H 'content-type: application/json' \
  --data '{
    "feedId": "org.hypercerts.feed.defs#hypercertsFeed",
    "params": {
      "$type": "org.hypercerts.feed.defs#hypercertsFeedParams",
      "viewerDid": "did:plc:ar7c4by46qjdydhdevvrndac",
      "trustedEvaluators": ["did:plc:ewvi7nxzyoun6zhxrhs64oiz"],
      "organizationQuality": {
        "allowed": ["high-quality", "standard"],
        "includeUnrated": false
      }
    },
    "limit": 20
  }'
```

Use the same body with `getFeedSkeleton` when another data system needs only ordered source AT-URIs. A service caller may add `-H 'authorization: Bearer <service-auth-jwt>'` and omit `viewerDid`; the token must target the bare DID configured as `SERVICE_DID`, carry the exact endpoint NSID in `lxm`, and be signed by the issuer's `#atproto` key. Invalid supplied authorization returns 401 and is never treated as anonymous. The public params union is open for future feed algorithms, including algorithms that accept no params. This service currently registers only `org.hypercerts.feed.defs#hypercertsFeed` and requires `org.hypercerts.feed.defs#hypercertsFeedParams`; missing params or a mismatched `$type` returns `InvalidRequest`, while an unknown `feedId` returns `UnsupportedFeed`.

### Skeleton response

```json
{
  "feed": [
    {
      "subject": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/org.hypercerts.claim.activity/3kpn"
    }
  ],
  "cursor": "eyJ2ZXJzaW9uIjoxLCJmZWVkSWQiOiJvcmcuaHlwZXJjZXJ0cy5mZWVkLmRlZnMjaHlwZXJjZXJ0c0ZlZWQiLCJ2YWx1ZSI6eyJ2YWx1ZSI6IjIwMjYtMDctMjFUMTA6MDA6MDAuMDAwMDAwWiIsInVyaSI6ImF0Oi8vZGlkOnBsYzpld3ZpN254enlvdW42emh4cmhzNjRvaXovb3JnLmh5cGVyY2VydHMuY2xhaW0uYWN0aXZpdHkvM2twbiJ9fQ"
}
```

Each skeleton entry intentionally contains only the source record AT-URI. A downstream hydrator resolves the current indexed record version; the skeleton does not pin hydration to a CID or expose feed-specific classification metadata. Send a returned cursor back as the top-level request `cursor`, never inside algorithm-specific `params`.

### Hydrated response

```json
{
  "feed": [
    {
      "subject": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/org.hypercerts.context.evaluation/3kpn",
      "view": {
        "$type": "org.hypercerts.feed.defs#hypercertsFeedView",
        "kind": "evaluation.create",
        "actor": {
          "did": "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
          "displayName": "Evaluator"
        },
        "content": {
          "$type": "org.hypercerts.feed.defs#evaluationView",
          "summary": "Strong evidence",
          "createdAt": "2026-07-21T10:00:00.000Z",
          "target": {
            "uri": "at://did:plc:ar7c4by46qjdydhdevvrndac/org.hypercerts.claim.activity/target",
            "cid": "bafyreifxcn6ts5hr6oequ5w5jyrpwrdl6p5lq46jasnxmcw3h3sme6asru"
          }
        }
      }
    }
  ]
}
```

Every hydrated entry has a generic source `subject` and an open `view` union. The current `hypercertsFeedView` variant owns the Hypercerts event kind, actor, and kind-specific content. Clients must tolerate unknown future feed-view and content variants.

#### What you get

Every hydrated feed entry comes from a valid source record. Each entry has a feed-specific view and kind-specific content.

The service uses a meaningful, valid Certified profile for an actor's display name and avatar. If no such profile is available, the actor is represented by their DID. It does not expose stored handles or fall back to Bluesky profiles.

An evaluation, measurement, or update may point to another record by its exact URI and CID. These targets remain strong references even though the entry's source `subject` is URI-only. The service checks that each target reference is valid.

Clients must accept image and feed formats they do not know. Known images keep their original Hypercerts and AT Protocol formats.

#### What the service does not do

The service removes invalid feed items and does not replace them. A page may therefore have fewer items than requested, or no items. The cursor still advances past every record the service checked.

The response never contains the original source JSON. It also does not say where actor details came from.

The service does not fetch, preview, or expand linked records. It only checks that the link contains a valid URI and CID.

The service does not contact a PDS, AppView, or HappyView API. It does not download or proxy image files.

## Request flow

```mermaid
sequenceDiagram
    actor Client
    participant HTTP as HTTP App
    participant XRPC as XRPC Handler
    participant Service as FeedService / HydratedFeedService
    participant Registry as Feed Registry
    participant Feed as Registered SQL Feed
    participant Identity as Identity Reader
    participant DB as HappyView PostgreSQL

    Client->>HTTP: POST feed procedure + optional Bearer JWT
    HTTP->>XRPC: Bounded, validated JSON
    XRPC->>XRPC: Verify audience, expiry, lxm, #atproto signature
    XRPC->>XRPC: Validate and consume issuer-scoped jti
    XRPC->>Service: Endpoint input + trusted viewer DID
    Service->>Registry: Load metadata or source-aware page
    Registry->>Feed: Dispatch feedId, optional params, and pagination
    Feed->>DB: One normalized HappyView selection statement
    DB-->>Feed: Scope and limit+1 metadata or exact sources
    Feed-->>Registry: Selected page and feed-scoped cursor
    Registry-->>Service: Selected page and cursor
    alt Hydrated endpoint
        Service->>Service: Validate sources and omit invalid rows
        Service->>Identity: Requested actor DIDs when needed
        Identity->>DB: One Certified-profile batch
        DB-->>Identity: Current profile contexts
        Identity-->>Service: Complete DID map
        Service-->>XRPC: Generic entries, feed-specific views, and selected-page cursor
    else Skeleton endpoint
        Service-->>XRPC: URI-only subjects and cursor
    end
    XRPC-->>HTTP: Procedure response
    HTTP-->>Client: JSON response
```

## Request behavior

- Malformed JSON, missing required params, anonymous requests without `params.viewerDid`, an authenticated supplied viewer mismatch, an invalid nested `viewerDid`, params that do not match the selected feed, or structurally invalid top-level pagination return HTTP 400 with `InvalidRequest`. Semantically invalid selected-feed parameters or pagination beyond that feed's supported range return HTTP 422 with the same generic error name and an actionable message. An unregistered `feedId` returns `UnsupportedFeed`. These never become internal server errors.
- A present `Authorization` header is always verified. Malformed, expired, not-yet-valid, wrong-audience, wrong-endpoint, unresolved-issuer, or incorrectly signed service JWTs return HTTP 401; the request is never retried anonymously. DID documents are resolved over bounded HTTPS-only requests with direct public-address pinning; `did:web` redirects and private, loopback, link-local, reserved, and special-use destinations are rejected.
- Service-auth JWTs must include a signed, non-empty `jti` no larger than 256 UTF-8 bytes. After signature, audience, expiry, and exact endpoint checks succeed, the service accepts each issuer-and-`jti` pair once. A token is consumed before the downstream feed request runs, so retries require a fresh token even when feed generation fails. Replay state is bounded to 512 live entries per verified issuer and 4,096 live entries total, local to the running process, cleared on restart, and not shared between replicas; a full live issuer quota or global store returns HTTP 503 until entries expire. Anonymous requests remain unaffected because they do not use service-auth replay state.

**Accepted pre-launch risk:** Eight verified issuers can each consume 512 live entries and fill the 4,096-entry process-wide store. While it is full, fresh valid tokens from unrelated issuers receive HTTP 503 until entries expire. The per-issuer cap does not prevent this cross-issuer denial of authenticated requests. Keep one-use tokens and fail-closed behavior for now; revisit capacity and abuse controls before relying on authenticated feed availability.

- The base scope always comes from the viewer's current `app.certified.graph.follow` records. The service ignores malformed follow subjects.
- `trustedEvaluators` adds the subjects of every current, active endorsement award from each evaluator.
- An endorsement definition with no `allowedIssuers` allows any issuer. When it is present, only its listed issuer DIDs qualify. An empty or malformed value allows no issuers.
- The service removes the viewer. It does not query actor status; only the current follow, award, and feed records present in HappyView affect selection.
- The organization-quality rules run against the final combined author list before event selection. Only exact `app.certified.actor.organization/self` records count as organizations.
- Trusted quality labelers come only from the service configuration. Quality labels are current positive `happyview_labels` rows matched to a bare organization DID. `cts` and `exp` are stored as TEXT and must be complete, finite RFC3339 or legacy PostgreSQL timestamp values; `cts` is validated but not used for ordering, and `exp` is validated before casting. Malformed, date-only, nonfinite, or elapsed values are inactive. HappyView removes a matching row when it receives a negation, and the table has no label CID or history. A row proves only that HappyView currently projects that label, not that every label was ingested. Callers cannot choose label sources.
- Leaving out `kinds`, or passing an empty list, includes every supported kind. Unknown kinds are rejected as `InvalidRequest`.

Supported event kinds:

```text
cert.create
collection.create
project.created_with_cert
evaluation.create
measurement.create
update.create
endorsement.award
```

Project and activity records are combined before kind filtering and pagination. After a collection is returned as `project.created_with_cert`, its paired activity cannot appear on a later page.

## Ordering and current-state behavior

The order is:

```text
feed timestamp DESC, record URI DESC
```

Entries appear newest first using an internal feed timestamp. HappyView stores record JSON and `indexed_at` as TEXT; the query validates JSON and timestamp text before casting, falls back from an invalid or absent `createdAt` to a finite, complete `indexed_at` in RFC3339 or legacy PostgreSQL format, and compares timestamps chronologically rather than lexically. Date-only and nonfinite fallback values are rejected. HappyView's `created_at` is row-ingestion time and is not used for feed ordering. Invalid source JSON does not abort selection; hydration drops an invalid selected source without backfilling. The effective timestamp is not exposed in either response. Pagination moves forward from the last source row chosen before hydration, so removing an invalid hydrated entry does not move the cursor.

### Pagination and database reads

**Pages**

- The service checks one extra item to see whether another page exists.
- The cursor marks the last item selected and is valid only for the `feedId` that issued it.
- Both endpoints use the same top-level pagination, ordering, and feed-scoped cursor rules.
- Invalid hydrated entries are removed, not replaced.

**Database work**

- A skeleton page uses one database query.
- A full feed page also loads actor and profile details when it has valid entries.
- The service never makes extra queries to fill gaps left by invalid entries.

**Freshness**

Feed entries and their source records are read together. Actor and profile details are loaded afterward, so they may be newer.

Each page is a separate database read. Changes made between requests may appear on later pages.

**Record size**

The service reads at most 51 source records per page. Their total size is not limited, so unusually large records may take longer and use more memory.

Source JSON is never returned.

## Runtime configuration

For local development, copy `.env.example` to `.env`. For deployment, copy its values into the deployment's variable configuration. The process can load a local `.env`, but it never replaces variables already set in the environment.

| Variable                         | Required |   Default | Purpose                                                                                |
| -------------------------------- | -------: | --------: | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   |      yes |           | Dedicated read-only Postgres URL for the HappyView database                            |
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
| `TRUSTED_QUALITY_LABELER_DIDS`   |       no |     empty | Comma-separated labeler DIDs trusted for current HappyView quality-label rows          |

For example, set `SERVICE_DID=did:web:dev.feed.hypercerts.dev` only when `https://dev.feed.hypercerts.dev` routes to this service; clients can discover its XRPC endpoint using `did:web:dev.feed.hypercerts.dev#hypercerts_feed`. This service does not publish a signing key: it verifies callers using their own DID documents. The DID service entry is for discovery and does not change JWT audience validation.

Service-auth audience verification currently accepts only the bare `SERVICE_DID`. [AT Protocol Proposal 0014](https://github.com/bluesky-social/proposals/blob/main/0014-service-auth-revised/README.md) defines the combined `did#serviceId` service reference, but the reference PDS currently emits the bare-DID service-auth audience and `@atproto/lex-server` does not yet support the combined audience form. This is separate from JWT `jti` replay protection, which this service now validates and consumes once per issuer in its bounded process-local replay state. Clients may still use a combined service reference for PDS proxy routing. When upstream support and PDS behavior are ready, update the verifier to accept an explicit allowlist of both audience forms.

If there are no configured trusted labelers, known organizations count as unrated whenever the request includes an organization-quality policy.

## Database access

Use a dedicated login that has only `SELECT` access. The service also sets `default_transaction_read_only=on` for every connection in the pool, but database grants are still the main security boundary.

Each service replica has its own limited in-process pool. When planning database connections, allow for `replica count × DATABASE_MAX_CONNECTIONS`. Use an external pooler if many replicas share a PostgreSQL server with few available connections.

Example operator setup:

```sql
CREATE ROLE hypercerts_feed_reader LOGIN PASSWORD '<managed-secret>';
GRANT CONNECT ON DATABASE happyview TO hypercerts_feed_reader;
GRANT USAGE ON SCHEMA public TO hypercerts_feed_reader;
GRANT SELECT ON TABLE public.happyview_records, public.happyview_labels
  TO hypercerts_feed_reader;
ALTER ROLE hypercerts_feed_reader SET default_transaction_read_only = on;
```

The service has no migrations or feed tables of its own. `/ready` checks that the database can be reached, PostgreSQL 16 can safely validate JSON and timestamp text, and the session is read-only. It does not check HappyView tables, labeler subscription health, label completeness, or ingestion freshness. See [`docs/database-contract.md`](docs/database-contract.md) for the runtime schema contract.

Before cutover, grant the service read-only access to `happyview_records` and `happyview_labels`, confirm that trusted labeler subscriptions are configured, and verify the record collections needed by this service are being stored. A present label row proves only that HappyView currently projects that label; it does not prove that every label was ingested.

## Development

You need Node.js 22.19+ and PostgreSQL 16+. The minimum Node.js version matches the `undici_v8` dependency used by service authentication.

```bash
npm install
npm run codegen
npm run check
npm run test:unit
npm run build
```

The committed project Lexicons in `lexicons/` define the public wire contract. `lexicons.json` pins active external Lexicon dependencies by AT-URI and CID; it currently includes `com.atproto.repo.strongRef`. The previously installed `app.bsky.actor.profile.json` file is intentionally preserved but is no longer an active dependency or used for identity hydration. The generated TypeScript in `src/lexicons/` is ignored. Do not edit or commit it. The `codegen`, `check`, test, and build commands regenerate it. Codegen stages only the standard `org.hypercerts.defs#uri`, `#smallBlob`, `#smallImage`, and `#largeImage` fragments from the pinned `@hypercerts-org/lexicon` package. This keeps the feed from committing duplicate definitions. `AGENTS.md` explains a small, focused workaround for the current `@atproto/lex` generator output that runs after codegen.

Check the committed network Lexicons against the manifest with:

```bash
npx --no-install lex install --ci --lexicons ./lexicons --manifest ./lexicons.json
```

Run `lex install --update` only when you mean to update those pinned dependencies.

The main feed statement is `src/feed/feed-query.sql`. `src/feed/query.ts` registers its Hypercerts feed definition, while `src/feed/registry.ts` and `src/feed/sql-feed.ts` own dispatch and shared SQL-feed execution policy. During development, the watcher watches the SQL along with the TypeScript source. The build copies it next to `dist/feed/query.js` before checking that the production adapters load.

### PostgreSQL integration tests

Integration tests need a PostgreSQL 16+ database that you explicitly choose and that is empty and safe to discard:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/hypercerts_feed_test' \
  npm run test:integration
```

The test suite creates the smallest needed contract tables and test rows. It does not drop or empty existing tables. Never point it at a shared, staging, or production database.

To test against HappyView's migrated schema, use a separate disposable database with no application rows:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/happyview_feed_test' \
  npm run test:integration:happyview
```

This command needs `psql`. It checks the HappyView columns used by the service, then runs the behavior suite, which inserts synthetic feed records and label rows. It does not apply HappyView migrations or prove that real records or labels have been ingested. Do not point it at a shared, staging, or production database. The suite has no supported label-import path; HappyView's label stream uses standard web PKI roots, so a self-signed local mock labeler cannot populate labels through the real subscription.

## Releases

Add a Changeset with `npm run changeset` when a pull request affects the service's behavior, runtime configuration, public contract, supported runtime versions, deployment, or operator procedures. Local development tools, tests, behavior-preserving internal refactors, documentation-only corrections, and repository or CI maintenance with no service or operator impact do not need one. CI allows omission but validates any included Changeset fragment before merge. GitHub creates approval-gated CI runs for the automated **Release** pull request. Maintainers approve those runs, wait for the full PostgreSQL-backed CI suite, and merge the Release pull request only after it passes. The release workflow then validates the exact merged commit and creates a Git tag and GitHub Release without publishing the private package to npm or deploying the service.

See [`docs/RELEASING.md`](docs/RELEASING.md) for the contributor and maintainer workflow.

## Deployment

```bash
docker build -t hypercerts-feed-service .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgresql://...' \
  -e SERVICE_DID='did:web:feed.example' \
  -e TRUSTED_QUALITY_LABELER_DIDS='did:plc:ar7c4by46qjdydhdevvrndac' \
  hypercerts-feed-service
```

Deploy the service beside HappyView and use private networking for the database.

To expose metrics, set a private metrics listener separate from the public application port:

```env
METRICS_HOST=0.0.0.0
METRICS_PORT=3001
```

Configure a compatible Prometheus collector to read `http://<private-service-host>:3001/metrics`. The `GET /metrics` response uses Prometheus-compatible exposition format. The listener has no application-level authentication, so do not attach a public domain or TCP proxy to the metrics port. Each replica exposes only its current in-memory registry; the collector owns aggregation, retention, and historical data. When `METRICS_PORT` is unset or empty, the metrics listener is disabled. `/metrics` remains unavailable on the public application port.

Set per-IP rate limits at the gateway. The first public policy allows 60 feed requests per minute for each client IP, with a burst of 20. When a client exceeds the limit, return HTTP 429 with `Retry-After`. Keep health and readiness private and outside this public limit. Adjust the limits using measured query response time and pool saturation.

The process limits request body size, HTTP request receive time, pool size, connection wait time, SQL statement duration, and DID-document resolution time. `REQUEST_TIMEOUT_MS` is not a deadline for the whole handler or query. After a complete POST body is buffered, downstream authentication uses a fresh signal because the current `@atproto/lex-server/nodejs` adapter aborts its request signal when the body ends normally. A client disconnect after the full body is received therefore does not cancel authentication or feed work; DID resolution and database timeouts still apply. Feed procedures allow browser requests from every origin and support `POST` preflight requests with `content-type` and `authorization` headers. They do not allow credentialed CORS requests. CORS does not authenticate callers or replace gateway rate limiting. Do not add rate-limit state to this service because separate replicas would disagree. Service-auth replay state is a separate bounded, process-local safeguard; it is not a distributed rate limiter.

## Operations

- `GET /.well-known/did.json`: serves the configured hostname-level `did:web` identity and `#hypercerts_feed` service entry; its endpoint comes from `SERVICE_DID`, not the request hostname.
- `GET /health`: checks only whether the process is alive.
- `GET /ready`: checks current database support and read-only state; the runtime schema contract is documented separately.
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

Public errors never show SQL, database credentials, table contents, internal causes, or stack traces.

## MVP boundaries

The service does not ingest data, write records, manage migrations, cache feed results across requests, call HappyView/PDS/AppView APIs, download blobs, hydrate target records, build target previews, recursively hydrate linked records, save preferences, or provide an unchangeable event history. It retains only bounded, process-local replay-protection state through the JWT `jti`; that state is not a feed-result cache. Results show HappyView's current, changeable data and its current freshness.
