# Bruno collection

Open this directory as a collection in [Bruno](https://www.usebruno.com/), then select the `local` environment, which targets a service running on `http://localhost:3000`. Add an environment with its own `baseUrl` to target a deployed service.

The environment defaults to a page limit of 10 and a sample `viewerDid`, the account whose follows scope **Feed - following**; the other feed requests are the activity feed and ignore it. Override `viewerDid`, `limit`, or `cursor` in Bruno when testing another viewer or page. Leave `cursor` empty for the first page, then paste a cursor returned by the service to load the next page. `cursor` is one variable shared by every request, and a cursor belongs to the feed that issued it: pasting a following cursor into an activity request (or the other way round) returns `InvalidCursor`, so clear it when you switch feeds.

The collection contains read-only health, readiness, feed, observations-only, following, and skeleton requests. The feed requests return references and selection metadata, not records. **Feed - following** requests the following feed (`#followingFeed`) and shows every one of its request parameters in one place; it is anonymous, so it names the viewer with `viewerDid`. Feed requests are unauthenticated and do not modify records.
