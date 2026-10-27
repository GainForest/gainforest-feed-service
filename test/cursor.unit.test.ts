import { describe, expect, it } from 'vitest'

import {
  decodeCursor,
  encodeCursor,
  timestampUriCursor,
} from '../src/feed/cursor.js'
import { type FeedError, FeedErrorCode } from '../src/feed/errors.js'

const feedId = 'app.gainforest.feed.defs#activityFeed'
const otherFeedId = 'app.gainforest.feed.defs#otherFeed'
const uri =
  'at://did:plc:ar7c4by46qjdydhdevvrndac/org.hypercerts.claim.activity/3kpn'
const row = {
  uri,
  sortValue: '2026-07-21T10:00:00.123456Z',
}

const encodePayload = (payload: unknown): string =>
  Buffer.from(JSON.stringify(payload)).toString('base64url')

const withValue = (value: unknown, version = 3): string =>
  encodePayload({ version, feedId, value })

const position = { value: '2026-07-21T10:00:00.000000Z', uri }

const expectInvalidCursor = (cursor: string): void => {
  expect(() => decodeCursor(feedId, cursor, timestampUriCursor)).toThrow(
    expect.objectContaining<Partial<FeedError>>({
      code: FeedErrorCode.InvalidCursor,
    }),
  )
}

describe('feed cursor', () => {
  it('round-trips a feed-scoped versioned keyset position', () => {
    const encoded = encodeCursor(feedId, row, timestampUriCursor)

    expect(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    ).toEqual({
      version: 3,
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

  // Version 1 could not say whether a page continues a run, and version 2
  // named the run a page cut in the cursor. Version 3 holds the last consumed
  // row only, so a client that still holds either starts again.
  it.each([1, 2])(
    'rejects a version %i cursor and says to request the first page again',
    (version) => {
      const encoded = withValue(position, version)

      expectInvalidCursor(encoded)
      expect(() => decodeCursor(feedId, encoded, timestampUriCursor)).toThrow(
        'version must be 3; discard this unsupported cursor and request the first page again',
      )
    },
  )

  it('rejects cursor payloads with unsupported fields', () => {
    const encoded = withValue({ sortBy: 'feedTimestamp', ...position })

    expectInvalidCursor(encoded)
  })

  it.each([
    'not base64url!',
    Buffer.from('not-json').toString('base64url'),
    withValue(position, 4),
    encodePayload({ version: 2, feedId, value: 'not-a-position' }),
  ])('rejects malformed or unsupported cursor %s', (cursor) => {
    expectInvalidCursor(cursor)
  })

  // The cursor holds a position and nothing a record controls. A group, even
  // an empty one, is not a cursor the service issued.
  it.each([
    [
      'a group of the version 2 shape',
      { key: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'audio' },
    ],
    ['an empty group', {}],
    ['a null group', null],
  ])('rejects a position that carries %s', (_name, group) => {
    const encoded = withValue({ ...position, group })

    expectInvalidCursor(encoded)
  })

  describe('cursor timestamp', () => {
    const cursorAt = (value: string): string =>
      withValue({ ...position, value })

    // PostgreSQL's timestamptz input rejects these although the RFC 3339 check
    // accepts them, which used to surface as a 500.
    it.each([
      ['a day the month does not have', '2026-02-30T00:00:00Z'],
      ['February 29th of a common year', '2026-02-29T00:00:00Z'],
      ['the 31st of a 30-day month', '2026-04-31T00:00:00Z'],
      ['year 0000', '0000-01-01T00:00:00Z'],
      ['a UTC offset of 16:00', '2026-01-01T00:00:00+16:00'],
      ['a UTC offset of -23:59', '2026-01-01T00:00:00-23:59'],
      ['an hour of 24', '2026-01-01T24:00:00Z'],
      ['a leap second', '2026-01-01T23:59:60Z'],
      ['no time zone', '2026-01-01T00:00:00'],
    ])('rejects a timestamp with %s as InvalidCursor', (_name, value) => {
      const encoded = cursorAt(value)

      expectInvalidCursor(encoded)
    })

    it.each([
      ['a leap day', '2024-02-29T12:00:00.123456Z'],
      ['year 0001', '0001-01-01T00:00:00Z'],
      ['the last second of year 9999', '9999-12-31T23:59:59.999999Z'],
      ['the largest UTC offset PostgreSQL takes', '2026-01-01T00:00:00+15:59'],
      ['the smallest UTC offset PostgreSQL takes', '2026-01-01T00:00:00-15:59'],
      ['a timestamp the service issued', '2026-07-21T10:00:00.123456Z'],
    ])('accepts a timestamp with %s', (_name, value) => {
      expect(decodeCursor(feedId, cursorAt(value), timestampUriCursor)).toEqual(
        { value, uri },
      )
    })
  })

  it('rejects a position with a missing field', () => {
    expectInvalidCursor(withValue({ value: position.value }))
    expectInvalidCursor(withValue({ uri }))
  })
})
