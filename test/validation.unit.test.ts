import { describe, expect, it } from 'vitest'

import { FeedErrorCode } from '../src/feed/errors.js'
import {
  ACTIVITY_FEED_PARAMS_TYPE,
  FOLLOWING_FEED_PARAMS_TYPE,
  type ActivityFeedParams,
  type FollowingFeedParams,
} from '../src/feed/types.js'
import {
  normalizeActivityRequest,
  normalizeFollowingRequest,
} from '../src/feed/validation.js'

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
  it('defaults to the feed of every kind', () => {
    expect(normalizeActivityRequest(params())).toEqual({
      filter: 'all',
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

  it('passes the cursor and an explicit limit through', () => {
    expect(
      normalizeActivityRequest(params(), { limit: 50, cursor: 'opaque' }),
    ).toMatchObject({ limit: 50, cursor: 'opaque' })
  })

  it.each([
    ['an unknown filter', params({ filter: 'donation' }), {}],
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

describe('normalizeFollowingRequest', () => {
  const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
  const following = (
    overrides: Partial<FollowingFeedParams> = {},
  ): FollowingFeedParams => ({
    $type: FOLLOWING_FEED_PARAMS_TYPE,
    viewerDid,
    ...overrides,
  })

  it('defaults to the feed of every kind for the viewer', () => {
    expect(normalizeFollowingRequest(following())).toEqual({
      filter: 'all',
      viewerDid,
      limit: 20,
    })
  })

  it('takes the filter, limit, and cursor like the activity feed', () => {
    expect(
      normalizeFollowingRequest(following({ filter: 'audio' }), {
        limit: 50,
        cursor: 'opaque',
      }),
    ).toEqual({ filter: 'audio', viewerDid, limit: 50, cursor: 'opaque' })
  })

  it.each([
    ['an unknown filter', following({ filter: 'donation' }), {}],
    ['a limit above the maximum', following(), { limit: 51 }],
    ['a zero limit', following(), { limit: 0 }],
  ])('rejects %s as InvalidRequest with HTTP 422', (_name, input, paging) => {
    expect(
      thrownBy(() => normalizeFollowingRequest(input, paging)),
    ).toMatchObject({ code: FeedErrorCode.InvalidRequest, status: 422 })
  })

  it('asks an anonymous request without a viewer to name one', () => {
    const error = thrownBy(() =>
      normalizeFollowingRequest({ $type: FOLLOWING_FEED_PARAMS_TYPE }),
    )

    expect(error).toMatchObject({
      code: FeedErrorCode.InvalidRequest,
      status: 422,
    })
    expect(String(error)).toContain(
      'send a service-auth bearer token or provide params.viewerDid',
    )
  })

  it.each([
    'alice.test',
    'did:plc:',
    'did:PLC:abc',
    `did:plc:${'a'.repeat(2_050)}`,
    '',
  ])('rejects the viewer %j that is not a syntactically valid DID', (did) => {
    expect(
      thrownBy(() => normalizeFollowingRequest(following({ viewerDid: did }))),
    ).toMatchObject({ code: FeedErrorCode.InvalidRequest, status: 422 })
  })
})
