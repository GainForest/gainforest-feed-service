import { describe, expect, it } from 'vitest'

import {
  decodeCursor,
  encodeCursor,
  timestampUriCursor,
} from '../src/feed/cursor.js'
import { type FeedError, FeedErrorCode } from '../src/feed/errors.js'

const feedId = 'org.hypercerts.feed.defs#hypercertsFeed'
const otherFeedId = 'org.hypercerts.feed.defs#otherFeed'
const uri =
  'at://did:plc:ar7c4by46qjdydhdevvrndac/org.hypercerts.claim.activity/3kpn'
const row = {
  uri,
  sortValue: '2026-07-21T10:00:00.123456Z',
}

describe('feed cursor', () => {
  it('round-trips a feed-scoped versioned keyset position', () => {
    const encoded = encodeCursor(feedId, row, timestampUriCursor)

    expect(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    ).toEqual({
      version: 1,
      feedId,
      value: {
        value: '2026-07-21T10:00:00.123456Z',
        uri,
      },
    })
    expect(decodeCursor(feedId, encoded, timestampUriCursor)).toEqual({
      value: '2026-07-21T10:00:00.123456Z',
      uri,
    })
  })

  it('rejects a cursor issued for another feed', () => {
    const encoded = encodeCursor(feedId, row, timestampUriCursor)

    expect(() =>
      decodeCursor(otherFeedId, encoded, timestampUriCursor),
    ).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidCursor,
      }),
    )
  })

  it('rejects cursor payloads with unsupported fields', () => {
    const encoded = Buffer.from(
      JSON.stringify({
        version: 1,
        feedId,
        value: {
          sortBy: 'feedTimestamp',
          value: '2026-07-21T10:00:00.000000Z',
          uri,
        },
      }),
    ).toString('base64url')

    expect(() => decodeCursor(feedId, encoded, timestampUriCursor)).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidCursor,
      }),
    )
  })

  it.each([
    'not base64url!',
    Buffer.from('not-json').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        version: 2,
        feedId,
        value: {
          value: '2026-07-21T10:00:00.000000Z',
          uri,
        },
      }),
    ).toString('base64url'),
    Buffer.from(
      JSON.stringify({ version: 1, feedId, value: 'not-a-position' }),
    ).toString('base64url'),
  ])('rejects malformed or unsupported cursor %s', (cursor) => {
    expect(() => decodeCursor(feedId, cursor, timestampUriCursor)).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidCursor,
      }),
    )
  })
})
