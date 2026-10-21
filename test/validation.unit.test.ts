import { describe, expect, it } from 'vitest'

import { type FeedError, FeedErrorCode } from '../src/feed/errors.js'
import type { HypercertsFeedParams } from '../src/feed/types.js'
import { normalizeFeedRequest } from '../src/feed/validation.js'

const paramsType = 'org.hypercerts.feed.defs#hypercertsFeedParams'
const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'

const feedParams = (
  params: Omit<HypercertsFeedParams, '$type'>,
): HypercertsFeedParams => ({ $type: paramsType, ...params })

describe('feed request validation', () => {
  it('normalizes the viewer-follow request defaults', () => {
    expect(
      normalizeFeedRequest(feedParams({ viewerDid: viewer })),
    ).toMatchObject({
      viewerDid: viewer,
      trustedEvaluators: [],
      kinds: [],
      limit: 20,
    })
  })

  it('deduplicates evaluator DIDs before applying the list limit', () => {
    const result = normalizeFeedRequest(
      feedParams({
        viewerDid: viewer,
        trustedEvaluators: Array.from({ length: 100 }, () => viewer),
      }),
    )

    expect(result.trustedEvaluators).toEqual([viewer])
  })

  it('reports Hypercerts parameter failures through the generic InvalidRequest error', () => {
    expect(() =>
      normalizeFeedRequest(
        feedParams({ viewerDid: viewer, kinds: ['cert.creat'] }),
      ),
    ).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
        status: 422,
      }),
    )

    const trustedEvaluators = Array.from(
      { length: 65 },
      (_, index) => `did:plc:${index.toString(36).padStart(24, 'a')}`,
    )
    expect(() =>
      normalizeFeedRequest(
        feedParams({ viewerDid: viewer, trustedEvaluators }),
      ),
    ).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
        status: 422,
      }),
    )
  })

  it('rejects empty event kind values', () => {
    expect(() =>
      normalizeFeedRequest(feedParams({ viewerDid: viewer, kinds: [''] })),
    ).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
        status: 422,
      }),
    )
  })

  it.each(['', 'excellent'])(
    'rejects unsupported organization quality %j',
    (quality) => {
      expect(() =>
        normalizeFeedRequest(
          feedParams({
            viewerDid: viewer,
            organizationQuality: {
              allowed: [quality],
              includeUnrated: false,
            },
          }),
        ),
      ).toThrow(
        expect.objectContaining<Partial<FeedError>>({
          code: FeedErrorCode.InvalidRequest,
        }),
      )
    },
  )

  it('rejects malformed viewers and page sizes', () => {
    expect(() =>
      normalizeFeedRequest(feedParams({ viewerDid: 'alice.test' })),
    ).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
      }),
    )
    expect(() =>
      normalizeFeedRequest(feedParams({ viewerDid: viewer }), { limit: 51 }),
    ).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
      }),
    )
  })
})
