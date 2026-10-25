/** SQLSTATE raised when PostgreSQL cancels a statement, including on statement_timeout. */
export const QUERY_CANCELED = '57014'

/** The SQLSTATE code carried by a PostgreSQL error, when the value is one. */
export const sqlState = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : undefined
