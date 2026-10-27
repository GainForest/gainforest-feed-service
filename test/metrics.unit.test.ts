import { describe, expect, it } from 'vitest'

import { Metrics } from '../src/metrics.js'

describe('Metrics', () => {
  // A page holds up to twice its limit of 50 items, so 100 items is a page
  // the service can answer and the last finite bucket has to cover it.
  it('counts a page of 100 items in a finite bucket', async () => {
    const metrics = new Metrics()
    metrics.observeResult(Array.from({ length: 100 }, () => 'post' as const))

    const exposition = await metrics.registry.metrics()

    expect(exposition).toContain(
      'hypercerts_feed_result_items_bucket{le="50"} 0',
    )
    expect(exposition).toContain(
      'hypercerts_feed_result_items_bucket{le="100"} 1',
    )
  })

  // The feed operation is one request of up to 10 statements, each bounded by
  // the statement timeout, so it can take much longer than one statement.
  it('counts a feed request of 20 seconds in a finite bucket', async () => {
    const metrics = new Metrics()
    metrics.observeDatabase('feed', 20, 'activity')

    const exposition = await metrics.registry.metrics()

    expect(exposition).toContain(
      'hypercerts_feed_database_duration_seconds_bucket{le="10",operation="feed",feed="activity"} 0',
    )
    expect(exposition).toContain(
      'hypercerts_feed_database_duration_seconds_bucket{le="25",operation="feed",feed="activity"} 1',
    )
  })

  // The following feed is the slower, viewer-dependent one, so operators need
  // its requests apart from the activity feed's. The label is a closed list.
  it('keeps one series per feed, and none for the readiness check', async () => {
    const metrics = new Metrics()
    metrics.observeDatabase('feed', 0.02, 'activity')
    metrics.observeDatabase('feed', 0.3, 'following')
    metrics.observeDatabase('feed', 0.4, 'following')
    metrics.observeDatabase('readiness', 0.01)

    const exposition = await metrics.registry.metrics()

    expect(exposition).toContain(
      'hypercerts_feed_database_duration_seconds_count{operation="feed",feed="activity"} 1',
    )
    expect(exposition).toContain(
      'hypercerts_feed_database_duration_seconds_count{operation="feed",feed="following"} 2',
    )
    expect(exposition).toContain(
      'hypercerts_feed_database_duration_seconds_count{operation="readiness"} 1',
    )
  })

  it('says that the feed operation spans a whole page request', async () => {
    const exposition = await new Metrics().registry.metrics()

    expect(exposition).toContain(
      'The feed operation is one whole page request, which sends up to 10 statements.',
    )
    expect(exposition).toContain(
      'Its feed label names the registered feed: activity or following.',
    )
  })
})
