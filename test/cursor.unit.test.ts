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
const did = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const folder = `at://${did}/app.gainforest.ac.deployment/f`
const key = 'AAAAAAAAAAAAAAAAAAAAAA'
const row = {
  uri,
  sortValue: '2026-07-21T10:00:00.123456Z',
}

const encodePayload = (payload: unknown): string =>
  Buffer.from(JSON.stringify(payload)).toString('base64url')

const withValue = (value: unknown, version = 2): string =>
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
      version: 2,
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

  it.each([
    ['an audio run', { key, kind: 'audio' }],
    ['a burst', { key, kind: 'observation' }],
  ] as const)('round-trips the open group of %s', (_name, group) => {
    const encoded = encodeCursor(feedId, { ...row, group }, timestampUriCursor)

    expect(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    ).toEqual({
      version: 2,
      feedId,
      value: { value: row.sortValue, uri, group },
    })
    expect(decodeCursor(feedId, encoded, timestampUriCursor)).toEqual({
      value: row.sortValue,
      uri,
      group,
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

  it('rejects a version 1 cursor, which cannot say whether a run continues', () => {
    const encoded = withValue(position, 1)

    expectInvalidCursor(encoded)
    expect(() => decodeCursor(feedId, encoded, timestampUriCursor)).toThrow(
      'version must be 2',
    )
  })

  it('rejects cursor payloads with unsupported fields', () => {
    const encoded = withValue({ sortBy: 'feedTimestamp', ...position })

    expectInvalidCursor(encoded)
  })

  it.each([
    'not base64url!',
    Buffer.from('not-json').toString('base64url'),
    withValue(position, 3),
    encodePayload({ version: 2, feedId, value: 'not-a-position' }),
  ])('rejects malformed or unsupported cursor %s', (cursor) => {
    expectInvalidCursor(cursor)
  })

  it.each([
    ['a group that is not an object', 'audio'],
    ['a group without a key', { kind: 'audio' }],
    ['a group without a kind', { key, extra: true }],
    [
      'a group key with characters outside base64url',
      { key: 'a b', kind: 'audio' },
    ],
    ['an empty group key', { key: '', kind: 'audio' }],
    ['a group key that is too long', { key: 'A'.repeat(65), kind: 'audio' }],
    ['a group of an unknown kind', { key, kind: 'post' }],
    // The statement reads the account and the folder from the database, so a
    // cursor that names them is not one the service issued.
    ['a group that names its account', { key, kind: 'audio', did }],
    ['a group that names its folder', { key, kind: 'audio', did, folder }],
    ['a group with an unsupported field', { key, kind: 'audio', extra: true }],
  ])('rejects %s', (_name, group) => {
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

  it('rejects an unsupported field next to a position that has no group', () => {
    const encoded = withValue({ ...position, groupKey: key })

    expectInvalidCursor(encoded)
  })
})
