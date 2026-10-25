# Bruno collection

Open this directory as a collection in [Bruno](https://www.usebruno.com/), then select the `local` environment, which targets a service running on `http://localhost:3000`. Add an environment with its own `baseUrl` to target a deployed service.

The environment defaults to a page limit of 10 and a sample `viewerDid`. Override `viewerDid`, `limit`, or `cursor` in Bruno when testing another viewer or page. Leave `cursor` empty for the first page, then paste a cursor returned by the service to load the next page.

The collection contains read-only health, readiness, feed, observations-only, following, and skeleton requests. The feed requests return references and selection metadata, not records. **Feed - following** shows every request parameter in one place. Feed requests are unauthenticated and do not modify records.
