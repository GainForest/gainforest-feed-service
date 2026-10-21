/** Stable public error names returned by the generic feed XRPC endpoints. */
export const FeedErrorCode = {
  InvalidRequest: 'InvalidRequest',
  UnsupportedFeed: 'UnsupportedFeed',
  InvalidCursor: 'InvalidCursor',
  InternalError: 'InternalError',
} as const

/** One stable public error name returned by the generic feed XRPC endpoints. */
export type FeedErrorCode = (typeof FeedErrorCode)[keyof typeof FeedErrorCode]

/** Expected feed failure that can be safely translated into a public XRPC response. */
export class FeedError extends Error {
  /** Creates a public error with an actionable message and HTTP status. */
  constructor(
    readonly code: FeedErrorCode,
    message: string,
    readonly status = 400,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'FeedError'
  }
}
