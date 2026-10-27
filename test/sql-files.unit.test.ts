import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(new URL(`../src/feed/${name}`, import.meta.url), 'utf8')

const activity = read('feed-query.sql')
const following = read('following-query.sql')

/** The `audio_keyed` CTE of a statement, from its name to the closing `),`. */
const audioKeyed = (sql: string): string => {
  const start = sql.indexOf('audio_keyed AS NOT MATERIALIZED (')
  const end = sql.indexOf('\n),\n', start)
  if (start === -1 || end === -1) {
    throw new Error('A statement has no audio_keyed CTE to compare.')
  }
  return sql.slice(start, end + 3)
}

/** The highest `$n` parameter a statement uses. */
const highestParameter = (sql: string): number =>
  Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))

describe('the two feed statements', () => {
  // The owner and folder of a recording are one rule that two statements
  // evaluate; the model has the third copy (`audioKey`). A drift between the
  // statements would make a recording belong to different owners in the two
  // feeds.
  it('derive the owner and the folder of a recording identically', () => {
    expect(audioKeyed(following)).toBe(audioKeyed(activity))
  })

  // The activity feed gives every caller the same page.
  it('keep every follow record out of the activity statement', () => {
    expect(activity).not.toContain('app.certified.graph.follow')
    expect(highestParameter(activity)).toBe(4)
  })

  it('give the following statement the viewer and the follow cap as its last two parameters', () => {
    expect(highestParameter(following)).toBe(6)
    expect(following).toContain('follow.did = $5::text')
    expect(following).toContain('LIMIT (SELECT $6::integer)')
  })

  it('apply the range guard to every read of a feed record', () => {
    const guarded = (sql: string): number =>
      [
        ...sql.matchAll(
          /^\s+AND \w+\.record_created_at BETWEEN '1970-01-01T00:00:00Z' AND now\(\) \+ interval '5 minutes'$/gm,
        ),
      ].length

    // Each kind is read once. The following statement reads recordings twice:
    // the ones a followed account stored, and the ones in its folders.
    expect(guarded(activity)).toBe(6)
    expect(guarded(following)).toBe(7)
  })

  it('limit every read by a number PostgreSQL cannot see', () => {
    for (const sql of [activity, following]) {
      expect(sql).not.toMatch(/LIMIT\s+\$\d/)
    }
    // The only literal limit is the one row that marks the end of a full batch.
    expect(activity).not.toMatch(/LIMIT\s+\d/)
    expect(following.match(/LIMIT\s+\d+/g)).toEqual(['LIMIT 1'])
  })
})
