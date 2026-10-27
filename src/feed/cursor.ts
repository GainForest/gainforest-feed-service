import { isAtUriString, isDatetimeString } from '@atproto/syntax'

import { FeedError, FeedErrorCode } from './errors.js'

/**
 * Version 3 is the last consumed row and nothing else. Versions 1 and 2, which
 * could not say, or said by naming a group, how a page continues an earlier
 * card, are rejected with `InvalidCursor`.
 */
const CURSOR_VERSION = 3
const MAX_CURSOR_LENGTH = 4096
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Feed-owned conversion between an opaque cursor position and one selected row. */
export interface CursorCodec<Cursor, Row> {
  decode(value: unknown): Cursor
  encode(row: Row): unknown
}

/**
 * Decoded feed position: the last row the previous page consumed. It carries
 * no record content, so what a record stores cannot grow a cursor, and the
 * client holds an unsigned token that the service trusts only to position that
 * client's own page.
 */
export interface FeedCursor {
  readonly value: string
  readonly uri: string
}

const invalidPosition = (message: string): FeedError =>
  new FeedError(
    FeedErrorCode.InvalidCursor,
    `${message}; use the cursor exactly as returned by the previous page.`,
  )

const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})T/
const UTC_OFFSET_HOURS = /[+-](\d{2}):\d{2}$/
/** PostgreSQL rejects a UTC offset beyond 15:59; RFC 3339 allows up to 23:59. */
const MAX_POSTGRES_OFFSET_HOURS = 15

/**
 * Whether `timestamptz` input accepts a string that already passed the RFC
 * 3339 check. `isDatetimeString` parses with `Date`, which rolls an impossible
 * day over (`2026-02-30` becomes March 2nd) and has a year 0000. PostgreSQL
 * rejects both, and any UTC offset beyond 15:59, with an error that would
 * surface as a 500 instead of an `InvalidCursor`.
 */
const isCastableTimestamp = (value: string): boolean => {
  const date = DATE_PREFIX.exec(value)
  if (date === null) return false
  const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])]
  if (year < 1) return false

  // A day the month does not have rolls into the next month, where the day of
  // the month is 1 to 3, so the day does not survive the round trip.
  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  if (calendar.getUTCDate() !== day) return false

  const offset = UTC_OFFSET_HOURS.exec(value)
  return offset === null || Number(offset[1]) <= MAX_POSTGRES_OFFSET_HOURS
}

/** Cursor position for feeds ordered by descending timestamp and URI. */
export const timestampUriCursor: CursorCodec<
  FeedCursor,
  {
    readonly uri: string
    readonly sortValue: string
  }
> = {
  decode(value) {
    if (!isRecord(value) || Object.keys(value).length !== 2) {
      throw invalidPosition('cursor position has the wrong shape')
    }

    const position = value
    if (
      typeof position.value !== 'string' ||
      !isDatetimeString(position.value)
    ) {
      throw invalidPosition('cursor value must be a valid RFC3339 timestamp')
    }
    if (!isCastableTimestamp(position.value)) {
      throw invalidPosition(
        'cursor value must be a date that exists, from year 0001, with a UTC offset of at most 15:59',
      )
    }
    if (
      typeof position.uri !== 'string' ||
      !isAtUriString(position.uri, { strict: false })
    ) {
      throw invalidPosition('cursor uri must be a valid AT-URI')
    }

    return { value: position.value, uri: position.uri }
  },
  encode: (row) => ({ value: row.sortValue, uri: row.uri }),
}

/** Encodes one feed-scoped position as unpadded base64url JSON. */
export const encodeCursor = <Cursor, Row>(
  feedId: string,
  row: Row,
  codec: CursorCodec<Cursor, Row>,
): string =>
  Buffer.from(
    JSON.stringify({
      version: CURSOR_VERSION,
      feedId,
      value: codec.encode(row),
    }),
    'utf8',
  ).toString('base64url')

/** Decodes a cursor and rejects positions issued for another feed. */
export const decodeCursor = <Cursor, Row>(
  feedId: string,
  cursor: string | undefined,
  codec: CursorCodec<Cursor, Row>,
): Cursor | undefined => {
  if (cursor === undefined || cursor === '') return undefined
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new FeedError(
      FeedErrorCode.InvalidCursor,
      `cursor exceeds the maximum encoded length of ${String(MAX_CURSOR_LENGTH)} characters; discard it and request the first page again.`,
    )
  }
  if (!BASE64URL_PATTERN.test(cursor)) {
    throw new FeedError(
      FeedErrorCode.InvalidCursor,
      'cursor is not valid unpadded base64url; use the cursor exactly as returned by the previous page.',
    )
  }

  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch (cause) {
    throw new FeedError(
      FeedErrorCode.InvalidCursor,
      'cursor does not contain valid JSON; discard it and request the first page again.',
      400,
      { cause },
    )
  }

  if (!isRecord(value) || Object.keys(value).length !== 3) {
    throw invalidPosition('cursor payload has the wrong shape')
  }

  const payload = value
  if (payload.version !== CURSOR_VERSION) {
    throw new FeedError(
      FeedErrorCode.InvalidCursor,
      `cursor version must be ${String(CURSOR_VERSION)}; discard this unsupported cursor and request the first page again.`,
    )
  }
  if (payload.feedId !== feedId) {
    throw new FeedError(
      FeedErrorCode.InvalidCursor,
      `cursor belongs to feedId ${JSON.stringify(payload.feedId)}, not ${JSON.stringify(feedId)}; discard it and request the first page for this feed.`,
    )
  }

  return codec.decode(payload.value)
}
