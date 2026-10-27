#!/usr/bin/env sh
set -eu

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo 'TEST_DATABASE_URL is required; use an empty disposable PostgreSQL database migrated with the Hyperindex schema.' >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo 'psql is required to verify the Hyperindex schema; install the PostgreSQL client and retry.' >&2
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
        ('record', 'uri', 'text'),
        ('record', 'cid', 'text'),
        ('record', 'did', 'text'),
        ('record', 'collection', 'text'),
        ('record', 'json', 'jsonb'),
        ('record', 'indexed_at', 'timestamp with time zone'),
        ('record', 'record_created_at', 'timestamp with time zone'),
        ('record', 'validation_status', 'text')
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
    expected_indexes(index_name) AS (
      VALUES
        ('idx_record_timeline_collection_created'),
        ('idx_record_timeline_author_collection_created'),
        ('idx_record_did_collection')
    ),
    index_issues AS (
      SELECT format('public.record index %s is missing', expected_indexes.index_name) AS issue
      FROM expected_indexes
      LEFT JOIN pg_indexes AS actual
        ON actual.schemaname = 'public'
       AND actual.tablename = 'record'
       AND actual.indexname = expected_indexes.index_name
      WHERE actual.indexname IS NULL
    ),
    version_issue AS (
      SELECT 'PostgreSQL 16 or newer is required' AS issue
      WHERE current_setting('server_version_num')::integer < 160000
    )
    SELECT string_agg(issue, E'\n' ORDER BY issue)
    FROM (
      SELECT issue FROM column_issues
      UNION ALL
      SELECT issue FROM index_issues
      UNION ALL
      SELECT issue FROM version_issue
    ) AS issues;
  ")

if [ -n "$issues" ]; then
  printf 'Hyperindex schema mismatch:\n%s\n' "$issues" >&2
  echo 'Migrate an isolated disposable database with the Hyperindex migrations; the service needs migration 010 (record_created_at and its timeline indexes), migration 001 (idx_record_did_collection) and migration 012 (validation_status). This check does not apply migrations.' >&2
  exit 1
fi

printf '%s\n' 'Hyperindex schema matches the feed service contract.'
