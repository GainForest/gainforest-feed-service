import { describe, expect, it } from 'vitest'

import { FeedErrorCode } from '../src/feed/errors.js'
import {
  ACTIVITY_FEED_PARAMS_TYPE,
  type ActivityFeedParams,
} from '../src/feed/types.js'
import { normalizeActivityRequest } from '../src/feed/validation.js'

const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'

const params = (
  overrides: Partial<ActivityFeedParams> = {},
): ActivityFeedParams => ({
  $type: ACTIVITY_FEED_PARAMS_TYPE,
  ...overrides,
})

const thrownBy = (action: () => unknown): unknown => {
  try {
    action()
  } catch (error) {
    return error
  }
  return undefined
}

describe('normalizeActivityRequest', () => {
  it('defaults to the unscoped feed of every kind', () => {
    expect(normalizeActivityRequest(params())).toEqual({
      filter: 'all',
      following: false,
      limit: 20,
    })
  })

  it('accepts every supported filter', () => {
    for (const filter of [
      'all',
      'project',
      'observation',
      'organization',
      'post',
      'audio',
    ]) {
      expect(normalizeActivityRequest(params({ filter })).filter).toBe(filter)
    }
  })

  it('keeps the viewer only when the feed is scoped to follows', () => {
    expect(
      normalizeActivityRequest(params({ viewerDid, following: true })),
    ).toEqual({ filter: 'all', following: true, viewerDid, limit: 20 })
    expect(normalizeActivityRequest(params({ viewerDid }))).toEqual({
      filter: 'all',
      following: false,
      limit: 20,
    })
  })

  it('passes the cursor and an explicit limit through', () => {
    expect(
      normalizeActivityRequest(params(), { limit: 50, cursor: 'opaque' }),
    ).toMatchObject({ limit: 50, cursor: 'opaque' })
  })

  it.each([
    ['an unknown filter', params({ filter: 'donation' }), {}],
    ['a malformed viewer DID', params({ viewerDid: 'not-a-did' }), {}],
    ['following without a viewer', params({ following: true }), {}],
    ['a zero limit', params(), { limit: 0 }],
    ['a limit above the maximum', params(), { limit: 51 }],
    ['a fractional limit', params(), { limit: 1.5 }],
  ])('rejects %s as InvalidRequest with HTTP 422', (_name, input, paging) => {
    expect(
      thrownBy(() => normalizeActivityRequest(input, paging)),
    ).toMatchObject({ code: FeedErrorCode.InvalidRequest, status: 422 })
  })

  it('names the supported filters when rejecting one', () => {
    expect(() =>
      normalizeActivityRequest(params({ filter: 'donation' })),
    ).toThrow(/all, project, observation, organization, post, audio/)
  })
})
