#!/usr/bin/env sh
set -eu

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo 'TEST_DATABASE_URL is required; use an empty disposable PostgreSQL database with the HappyView schema.' >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo 'psql is required to verify the HappyView schema; install the PostgreSQL client and retry.' >&2
  exit 1
fi

issues=$(psql "$TEST_DATABASE_URL" \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --tuples-only \
  --no-align \
  --quiet \
  --command "
    WITH expected(table_name, column_name, data_type) AS (
      VALUES
        ('happyview_records', 'uri', 'text'),
        ('happyview_records', 'did', 'text'),
        ('happyview_records', 'collection', 'text'),
        ('happyview_records', 'rkey', 'text'),
        ('happyview_records', 'record', 'text'),
        ('happyview_records', 'cid', 'text'),
        ('happyview_records', 'indexed_at', 'text'),
        ('happyview_records', 'created_at', 'text'),
        ('happyview_labels', 'src', 'text'),
        ('happyview_labels', 'uri', 'text'),
        ('happyview_labels', 'val', 'text'),
        ('happyview_labels', 'cts', 'text'),
        ('happyview_labels', 'exp', 'text')
    ),
    column_issues AS (
      SELECT format(
        'public.%s.%s expected %s, found %s',
        expected.table_name,
        expected.column_name,
        expected.data_type,
        COALESCE(actual.data_type, 'missing')
      ) AS issue
      FROM expected
      LEFT JOIN information_schema.columns AS actual
        ON actual.table_schema = 'public'
       AND actual.table_name = expected.table_name
       AND actual.column_name = expected.column_name
      WHERE actual.column_name IS NULL
         OR actual.data_type <> expected.data_type
    ),
    version_issue AS (
      SELECT 'PostgreSQL 16 or newer is required' AS issue
      WHERE current_setting('server_version_num')::integer < 160000
    )
    SELECT string_agg(issue, E'\n' ORDER BY issue)
    FROM (
      SELECT issue FROM column_issues
      UNION ALL
      SELECT issue FROM version_issue
    ) AS issues;
  ")

if [ -n "$issues" ]; then
  printf 'HappyView schema mismatch:\n%s\n' "$issues" >&2
  echo 'Migrate an isolated disposable database with the HappyView migrations; this check does not apply migrations.' >&2
  exit 1
fi

printf '%s\n' 'HappyView schema matches the feed service contract.'
