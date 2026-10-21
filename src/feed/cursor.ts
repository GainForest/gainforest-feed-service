import { isAtUriString, isDatetimeString } from '@atproto/syntax'

import { FeedError, FeedErrorCode } from './errors.js'

const CURSOR_VERSION = 1
const MAX_CURSOR_LENGTH = 4096
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Feed-owned conversion between an opaque cursor position and one selected row. */
export interface CursorCodec<Cursor, Row> {
  decode(value: unknown): Cursor
  encode(row: Row): unknown
}

/** Decoded timestamp-and-URI position used by the current Hypercerts feed. */
export interface FeedCursor {
  readonly value: string
  readonly uri: string
}

const invalidPosition = (message: string): FeedError =>
  new FeedError(
    FeedErrorCode.InvalidCursor,
    `${message}; use the cursor exactly as returned by the previous page.`,
  )

/** Cursor position for feeds ordered by descending timestamp and URI. */
export const timestampUriCursor: CursorCodec<
  FeedCursor,
  { readonly uri: string; readonly sortValue: string }
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
