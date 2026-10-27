import { describe, expect, it } from 'vitest'

import { applyAuthenticatedViewer } from '../src/auth/input.js'
import type { ServiceAuthCredentials } from '../src/auth/service-auth.js'
import { FeedError, FeedErrorCode } from '../src/feed/errors.js'
import {
  ACTIVITY_FEED_ID,
  ACTIVITY_FEED_PARAMS_TYPE,
  FOLLOWING_FEED_ID,
  FOLLOWING_FEED_PARAMS_TYPE,
  type FeedRequest,
} from '../src/feed/types.js'

const caller = 'did:plc:ar7c4by46qjdydhdevvrndac'
const other = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'

const credentials = (
  did: ServiceAuthCredentials['did'],
): ServiceAuthCredentials => ({
  did,
  didDocument: { id: did },
  jwt: {
    header: { alg: 'ES256' },
    payload: {
      iss: did,
      aud: 'did:web:feed.example',
      exp: 1,
      lxm: 'app.gainforest.feed.getFeed',
    },
    message: new Uint8Array(),
    signature: new Uint8Array(),
  },
})

const following = (
  params?: Record<string, unknown>,
  extra: Partial<FeedRequest> = {},
): FeedRequest => ({
  feedId: FOLLOWING_FEED_ID,
  ...(params === undefined
    ? {}
    : { params: { $type: FOLLOWING_FEED_PARAMS_TYPE, ...params } }),
  ...extra,
})

const thrownBy = (action: () => unknown): unknown => {
  try {
    action()
  } catch (error) {
    return error
  }
  return undefined
}

describe('applyAuthenticatedViewer', () => {
  describe('an authenticated following feed request', () => {
    it('makes the verified caller the viewer when params are omitted', () => {
      expect(
        applyAuthenticatedViewer(
          following(undefined, { limit: 5, cursor: 'c' }),
          credentials(caller),
        ),
      ).toEqual({
        feedId: FOLLOWING_FEED_ID,
        params: { $type: FOLLOWING_FEED_PARAMS_TYPE, viewerDid: caller },
        limit: 5,
        cursor: 'c',
      })
    })

    it('adds the caller to params without a viewerDid and keeps the filter', () => {
      expect(
        applyAuthenticatedViewer(
          following({ filter: 'post' }),
          credentials(caller),
        ).params,
      ).toEqual({
        $type: FOLLOWING_FEED_PARAMS_TYPE,
        filter: 'post',
        viewerDid: caller,
      })
    })

    it('accepts a viewerDid that is the caller', () => {
      expect(
        applyAuthenticatedViewer(
          following({ viewerDid: caller }),
          credentials(caller),
        ).params,
      ).toMatchObject({ viewerDid: caller })
    })

    it.each([other, 'alice.test', ''])(
      'rejects the viewerDid %j that is not the caller',
      (viewerDid) => {
        const error = thrownBy(() =>
          applyAuthenticatedViewer(
            following({ viewerDid }),
            credentials(caller),
          ),
        )

        expect(error).toBeInstanceOf(FeedError)
        expect(error).toMatchObject({
          code: FeedErrorCode.InvalidRequest,
          status: 400,
        })
        expect(String(error)).toContain(
          'does not match the authenticated service caller',
        )
      },
    )
  })

  describe('an anonymous following feed request', () => {
    it('passes a viewerDid through untouched', () => {
      const input = following({ viewerDid: other })

      expect(applyAuthenticatedViewer(input, undefined)).toBe(input)
    })

    it.each([
      ['no params', following()],
      ['params without a viewerDid', following({ filter: 'post' })],
    ])('requires a viewerDid when it sends %s', (_name, input) => {
      const error = thrownBy(() => applyAuthenticatedViewer(input, undefined))

      expect(error).toMatchObject({
        code: FeedErrorCode.InvalidRequest,
        status: 400,
      })
      expect(String(error)).toContain(
        'params.viewerDid is required for an anonymous following feed request',
      )
      expect(String(error)).toContain('send a valid service-auth bearer token')
    })

    // A service that verifies no tokens cannot be told to send one.
    it('does not suggest a token when the service accepts none', () => {
      const error = thrownBy(() =>
        applyAuthenticatedViewer(following(), undefined, false),
      )

      expect(error).toMatchObject({
        code: FeedErrorCode.InvalidRequest,
        status: 400,
      })
      expect(String(error)).toContain('params.viewerDid is required')
      expect(String(error)).not.toMatch(/token|bearer/i)
    })
  })

  describe('everything that is not a following feed request', () => {
    const activity: FeedRequest = {
      feedId: ACTIVITY_FEED_ID,
      params: { $type: ACTIVITY_FEED_PARAMS_TYPE, filter: 'post' },
    }

    it('gives the activity feed the same request with and without a caller', () => {
      expect(applyAuthenticatedViewer(activity, credentials(caller))).toBe(
        activity,
      )
      expect(applyAuthenticatedViewer(activity, undefined)).toBe(activity)
    })

    it('leaves following params sent to the activity feed to the registry', () => {
      const input: FeedRequest = {
        feedId: ACTIVITY_FEED_ID,
        params: { $type: FOLLOWING_FEED_PARAMS_TYPE, viewerDid: other },
      }

      expect(applyAuthenticatedViewer(input, credentials(caller))).toBe(input)
      expect(applyAuthenticatedViewer(input, undefined)).toBe(input)
    })

    it('leaves activity params sent to the following feed to the registry', () => {
      const input: FeedRequest = {
        feedId: FOLLOWING_FEED_ID,
        params: { $type: ACTIVITY_FEED_PARAMS_TYPE },
      }

      expect(applyAuthenticatedViewer(input, credentials(caller))).toBe(input)
      expect(applyAuthenticatedViewer(input, undefined)).toBe(input)
    })

    it('leaves a feed this service does not register to the registry', () => {
      const input: FeedRequest = {
        feedId: 'app.example.feed.defs#futureFeed',
        params: { $type: 'app.example.feed.defs#futureParams' },
      }

      expect(applyAuthenticatedViewer(input, credentials(caller))).toBe(input)
    })
  })
})
