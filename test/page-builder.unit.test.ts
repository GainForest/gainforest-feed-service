import { describe, expect, it } from 'vitest'

import { PageBuilder, type FeedRow } from '../src/feed/page-builder.js'
import type { SelectedItem } from '../src/feed/sql-feed.js'
import {
  GROUP_ITEM_TYPE,
  GROUP_SAMPLE_SIZE,
  MIN_GROUP_ROWS,
  RECORD_ITEM_TYPE,
  REPOST_ITEM_TYPE,
  type GroupItem,
} from '../src/feed/types.js'

const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const alice = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const bob = 'did:plc:ar7c4by46qjdydhdevvrndac'
const carol = 'did:plc:5dlbsrghpuhzwbmq7vcowxvd'
const folderOf = (owner: string, name: string): string =>
  `at://${owner}/app.gainforest.ac.deployment/${name}`

const HOUR = 3_600_000_000
const BASE = Date.parse('2026-03-01T00:00:00.000Z') * 1_000

/** Time `micros` microseconds after the fixture epoch, as the statement formats it. */
const timeAt = (micros: number) => ({
  micros: BASE + micros,
  sortValue: new Date((BASE + micros) / 1_000)
    .toISOString()
    .replace(/\.(\d{3})Z$/, (_, ms: string) => {
      const fraction = String((BASE + micros) % 1_000).padStart(3, '0')
      return `.${ms}${fraction}Z`
    }),
})

/** Rows are numbered in feed order by their time: a larger offset is newer. */
const observation = (
  did: string,
  rkey: string,
  micros: number,
  bioacoustic = false,
): FeedRow => ({
  kind: 'observation',
  uri: `at://${did}/app.gainforest.dwc.occurrence/${rkey}`,
  cid,
  did,
  bioacoustic,
  ...timeAt(micros),
})

const recording = (
  owner: string,
  folder: string | null,
  rkey: string,
  micros: number,
  storedBy = owner,
): FeedRow => ({
  kind: 'audio',
  uri: `at://${storedBy}/app.gainforest.ac.audio/${rkey}`,
  cid,
  did: storedBy,
  owner,
  folder,
  ...timeAt(micros),
})

const post = (did: string, rkey: string, micros: number): FeedRow => ({
  kind: 'post',
  uri: `at://${did}/app.gainforest.feed.post/${rkey}`,
  cid,
  did,
  ...timeAt(micros),
})

const rkeyOf = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1)

/** Feeds rows, newest first, until the page refuses one. */
const fill = (limit: number, rows: readonly FeedRow[]) => {
  const page = new PageBuilder(limit)
  const refused: string[] = []
  for (const row of rows) {
    if (!page.accept(row)) {
      refused.push(rkeyOf(row.uri))
      break
    }
  }
  return { page, refused }
}

/** `observation(3):a,b,c` for a group, `post:p1` for a record, in item order. */
const labels = (items: readonly SelectedItem[]): string[] =>
  items.map(({ item }) => {
    switch (item.$type) {
      case RECORD_ITEM_TYPE:
        return `${item.kind}:${rkeyOf(item.uri)}`
      case REPOST_ITEM_TYPE:
        return `repost:${rkeyOf(item.uri)}`
      case GROUP_ITEM_TYPE:
        return `${item.kind}(${String(item.total)}):${item.subjects.map(rkeyOf).join(',')}`
    }
  })

const groupsOf = (items: readonly SelectedItem[]): GroupItem[] =>
  items.flatMap(({ item }) => (item.$type === GROUP_ITEM_TYPE ? [item] : []))

describe('PageBuilder', () => {
  describe('groups', () => {
    it('folds three rows of one account into a card placed at its newest row', () => {
      const { page } = fill(20, [
        observation(alice, 'o3', 3_000_000),
        observation(alice, 'o2', 2_000_000),
        observation(alice, 'o1', 1_000_000),
      ])

      const { items, next } = page.finish('exhausted')

      expect(labels(items)).toEqual(['observation(3):o3,o2,o1'])
      expect(items[0]?.uris).toEqual([
        `at://${alice}/app.gainforest.dwc.occurrence/o3`,
        `at://${alice}/app.gainforest.dwc.occurrence/o2`,
        `at://${alice}/app.gainforest.dwc.occurrence/o1`,
      ])
      expect(next).toBeUndefined()
      expect(groupsOf(items)[0]).toMatchObject({
        $type: GROUP_ITEM_TYPE,
        kind: 'observation',
        did: alice,
        total: 3,
        from: '2026-03-01T00:00:01.000000Z',
        to: '2026-03-01T00:00:03.000000Z',
      })
    })

    it('is not broken by rows of other kinds, accounts or folders between its rows', () => {
      const folder = folderOf(alice, 'f')
      const { page } = fill(20, [
        recording(alice, folder, 'a6', 90_000_000),
        post(bob, 'p-between', 80_000_000),
        recording(alice, folder, 'a5', 70_000_000),
        recording(bob, folderOf(bob, 'g'), 'b-between', 60_000_000),
        recording(alice, folder, 'a4', 50_000_000),
        observation(carol, 'o-between', 40_000_000),
        recording(alice, folder, 'a3', 30_000_000),
        recording(alice, null, 'a-other-folder', 20_000_000),
        recording(alice, folder, 'a2', 10_000_000),
      ])

      const { items } = page.finish('exhausted')

      expect(labels(items)).toEqual([
        'audio(5):a6,a5,a4,a3,a2',
        'post:p-between',
        'audio:b-between',
        'observation:o-between',
        'audio:a-other-folder',
      ])
    })

    it('keeps groups apart by kind, owner and folder', () => {
      const { page } = fill(20, [
        recording(alice, folderOf(alice, 'f'), 'f3', 9_000_000),
        recording(alice, folderOf(alice, 'g'), 'g3', 8_000_000),
        recording(alice, null, 'n3', 7_000_000),
        recording(alice, null, 'n2', 6_000_000),
        observation(alice, 'o3', 5_000_000),
        observation(bob, 'b3', 4_000_000),
        recording(alice, folderOf(alice, 'g'), 'g2', 3_000_000),
        recording(alice, folderOf(alice, 'f'), 'f2', 2_000_000),
        recording(alice, null, 'n1', 1_500_000),
        observation(alice, 'o2', 1_400_000),
        observation(bob, 'b2', 1_300_000),
        observation(alice, 'o1', 1_200_000),
        observation(bob, 'b1', 1_100_000),
        recording(alice, folderOf(alice, 'f'), 'f1', 1_000_000),
        recording(alice, folderOf(alice, 'g'), 'g1', 900_000),
      ])

      const { items } = page.finish('exhausted')

      expect(labels(items)).toEqual([
        'audio(3):f3,f2,f1',
        'audio(3):g3,g2,g1',
        'audio(3):n3,n2,n1',
        'observation(3):o3,o2,o1',
        'observation(3):b3,b2,b1',
      ])
      const keys = groupsOf(items).map((group) => group.groupKey)
      expect(new Set(keys).size).toBe(5)
    })

    it('shows a group of one or two rows as separate records at their own positions', () => {
      const { page } = fill(20, [
        observation(alice, 'o2', 9_000_000),
        post(bob, 'p2', 8_000_000),
        observation(alice, 'o1', 7_000_000),
        recording(carol, null, 'a2', 6_000_000),
        post(bob, 'p1', 5_000_000),
        recording(carol, null, 'a1', 4_000_000),
        observation(bob, 'lone', 3_000_000),
      ])

      const { items } = page.finish('exhausted')

      expect(labels(items)).toEqual([
        'observation:o2',
        'post:p2',
        'observation:o1',
        'audio:a2',
        'post:p1',
        'audio:a1',
        'observation:lone',
      ])
      expect(items.map(({ uris }) => uris.length)).toEqual(items.map(() => 1))
    })

    it('places a group at its newest row and a smaller group member at its own', () => {
      // alice has 4 rows; bob has 2 rows, one before and one after alice's
      // newest row. The group of alice sits at her newest row.
      const { page } = fill(20, [
        observation(bob, 'b2', 9_000_000),
        observation(alice, 'a4', 8_000_000),
        post(carol, 'p', 7_000_000),
        observation(alice, 'a3', 6_000_000),
        observation(bob, 'b1', 5_000_000),
        observation(alice, 'a2', 4_000_000),
        observation(alice, 'a1', 3_000_000),
      ])

      const { items } = page.finish('exhausted')

      expect(labels(items)).toEqual([
        'observation:b2',
        'observation(4):a4,a3,a2,a1',
        'post:p',
        'observation:b1',
      ])
    })

    it(`builds a card at ${String(MIN_GROUP_ROWS)} rows and not before`, () => {
      const rows = [
        observation(alice, 'o3', 3_000_000),
        observation(alice, 'o2', 2_000_000),
        observation(alice, 'o1', 1_000_000),
      ]

      expect(
        labels(fill(20, rows.slice(0, 2)).page.finish('exhausted').items),
      ).toEqual(['observation:o3', 'observation:o2'])
      expect(labels(fill(20, rows).page.finish('exhausted').items)).toEqual([
        'observation(3):o3,o2,o1',
      ])
    })

    it('never groups bioacoustic sightings, reposts, posts, projects or organizations', () => {
      const standalone = (
        kind: 'project' | 'organization' | 'post',
        rkey: string,
        micros: number,
      ): FeedRow => ({
        kind,
        uri: `at://${alice}/x.example.${kind}/${rkey}`,
        cid,
        did: alice,
        ...timeAt(micros),
      })
      const repost = (rkey: string, micros: number): FeedRow => ({
        kind: 'repost',
        uri: `at://${alice}/app.gainforest.feed.repost/${rkey}`,
        cid,
        did: alice,
        subject: `at://${bob}/app.gainforest.feed.post/s`,
        ...timeAt(micros),
      })
      const rows = [
        observation(alice, 'sound4', 12_000_000, true),
        observation(alice, 'sound3', 11_000_000, true),
        observation(alice, 'sound2', 10_000_000, true),
        observation(alice, 'sound1', 9_000_000, true),
        repost('r3', 8_000_000),
        repost('r2', 7_000_000),
        repost('r1', 6_000_000),
        standalone('post', 'p3', 5_000_000),
        standalone('post', 'p2', 4_500_000),
        standalone('post', 'p1', 4_000_000),
        standalone('project', 'c3', 3_000_000),
        standalone('project', 'c2', 2_500_000),
        standalone('project', 'c1', 2_000_000),
        standalone('organization', 'self', 1_000_000),
      ]

      const { items } = fill(50, rows).page.finish('exhausted')

      expect(labels(items)).toEqual([
        'observation:sound4',
        'observation:sound3',
        'observation:sound2',
        'observation:sound1',
        'repost:r3',
        'repost:r2',
        'repost:r1',
        'post:p3',
        'post:p2',
        'post:p1',
        'project:c3',
        'project:c2',
        'project:c1',
        'organization:self',
      ])
    })

    it('does not let a bioacoustic sighting join, or break, its account’s group', () => {
      const { page } = fill(20, [
        observation(alice, 'photo3', 4_000_000),
        observation(alice, 'sound', 3_000_000, true),
        observation(alice, 'photo2', 2_000_000),
        observation(alice, 'photo1', 1_000_000),
      ])

      expect(labels(page.finish('exhausted').items)).toEqual([
        'observation(3):photo3,photo2,photo1',
        'observation:sound',
      ])
    })
  })

  describe('the 12-hour gap', () => {
    const run = (gaps: readonly number[]): FeedRow[] => {
      let at = 100 * HOUR
      return [
        observation(alice, 'o0', at),
        ...gaps.map((gap, index) => {
          at -= gap
          return observation(alice, `o${String(index + 1)}`, at)
        }),
      ]
    }

    it('joins a row exactly 12 hours older than the previous row of its group', () => {
      const { page } = fill(20, run([12 * HOUR, 12 * HOUR]))

      expect(labels(page.finish('exhausted').items)).toEqual([
        'observation(3):o0,o1,o2',
      ])
    })

    it('starts a new card for a row a microsecond further away, and the old one is closed', () => {
      const { page } = fill(20, run([HOUR, 12 * HOUR + 1, HOUR, HOUR]))

      const { items } = page.finish('exhausted')

      expect(labels(items)).toEqual([
        'observation:o0',
        'observation:o1',
        'observation(3):o2,o3,o4',
      ])
    })

    it('measures the gap from the oldest row so far, so a long chain of short gaps stays one card', () => {
      const { page } = fill(
        20,
        run([11 * HOUR, 11 * HOUR, 11 * HOUR, 11 * HOUR]),
      )

      expect(labels(page.finish('exhausted').items)).toEqual([
        'observation(5):o0,o1,o2,o3,o4',
      ])
    })

    it('splits a group into cards that share one groupKey', () => {
      const { page } = fill(
        20,
        run([HOUR, HOUR, 13 * HOUR, HOUR, HOUR, 13 * HOUR, HOUR]),
      )

      const groups = groupsOf(page.finish('exhausted').items)

      expect(groups.map((group) => group.total)).toEqual([3, 3])
      expect(groups[0]?.groupKey).toBe(groups[1]?.groupKey)
    })

    it('does not look at other groups’ rows when it measures a gap', () => {
      // alice's two rows are 20 hours apart, but bob's rows between them
      // keep arriving every hour. alice does not join across her own gap.
      const rows = [
        observation(alice, 'a2', 30 * HOUR),
        ...Array.from({ length: 19 }, (_, index) =>
          post(bob, `p${String(index)}`, (29 - index) * HOUR),
        ),
        observation(alice, 'a1', 10 * HOUR),
      ]

      const { items } = fill(50, rows).page.finish('exhausted')

      expect(
        labels(items).filter((label) => label.includes('observation')),
      ).toEqual(['observation:a2', 'observation:a1'])
    })
  })

  describe('the stop rule', () => {
    it('takes rows that join an open card after the page has its cards, and stops at the first row that would start another', () => {
      const { page, refused } = fill(2, [
        observation(alice, 'a3', 9_000_000),
        observation(bob, 'b3', 8_000_000),
        observation(alice, 'a2', 7_000_000),
        observation(bob, 'b2', 6_000_000),
        observation(alice, 'a1', 5_000_000),
        post(carol, 'p1', 4_000_000),
        observation(bob, 'b1', 3_000_000),
      ])

      const { items, next } = page.finish('full')

      expect(refused).toEqual(['p1'])
      expect(labels(items)).toEqual([
        'observation(3):a3,a2,a1',
        'observation:b3',
        'observation:b2',
      ])
      expect(next).toEqual({
        sortValue: '2026-03-01T00:00:05.000000Z',
        uri: `at://${alice}/app.gainforest.dwc.occurrence/a1`,
      })
    })

    it('takes no row after it refused one, even a row that would join', () => {
      const page = new PageBuilder(1)
      expect(page.accept(observation(alice, 'a3', 9_000_000))).toBe(true)
      expect(page.accept(post(bob, 'p', 8_000_000))).toBe(false)

      // alice's next row joins her open card, but the page ended before it.
      expect(page.accept(observation(alice, 'a2', 7_000_000))).toBe(false)
      expect(labels(page.finish('full').items)).toEqual(['observation:a3'])
      expect(page.last?.uri).toBe(
        `at://${alice}/app.gainforest.dwc.occurrence/a3`,
      )
    })

    it('holds up to twice the limit when every card is a group of two', () => {
      const { page } = fill(3, [
        observation(alice, 'a2', 9_000_000),
        observation(bob, 'b2', 8_000_000),
        observation(carol, 'c2', 7_000_000),
        observation(alice, 'a1', 6_000_000),
        observation(bob, 'b1', 5_000_000),
        observation(carol, 'c1', 4_000_000),
        post(alice, 'next-card', 3_000_000),
      ])

      const { items } = page.finish('full')

      expect(labels(items)).toEqual([
        'observation:a2',
        'observation:b2',
        'observation:c2',
        'observation:a1',
        'observation:b1',
        'observation:c1',
      ])
    })

    it('has no next position when the data ended', () => {
      const { items, next } = fill(5, [
        post(alice, 'p2', 2_000_000),
        post(alice, 'p1', 1_000_000),
      ]).page.finish('exhausted')

      expect(labels(items)).toEqual(['post:p2', 'post:p1'])
      expect(next).toBeUndefined()
    })

    it('points the next page at the last consumed row when it stopped for any reason but the end of the data', () => {
      const rows = [post(alice, 'p2', 2_000_000), post(alice, 'p1', 1_000_000)]

      for (const stop of ['full', 'budget'] as const) {
        expect(fill(5, rows).page.finish(stop).next).toEqual({
          sortValue: '2026-03-01T00:00:01.000000Z',
          uri: `at://${alice}/app.gainforest.feed.post/p1`,
        })
      }
    })

    it('has no next position and no items before it consumes a row', () => {
      const page = new PageBuilder(3)

      expect(page.last).toBeUndefined()
      expect(page.finish('exhausted')).toEqual({ items: [] })
      expect(page.finish('budget')).toEqual({ items: [] })
    })

    it('rejects a row that is newer than the one before it', () => {
      const page = new PageBuilder(3)
      page.accept(post(alice, 'p1', 1_000_000))

      expect(() => page.accept(post(alice, 'p2', 2_000_000))).toThrow(
        'Activity feed query invariant failed',
      )
    })
  })

  describe('more', () => {
    const dump = [
      recording(alice, folderOf(alice, 'f'), 'f3', 9_000_000),
      recording(alice, folderOf(alice, 'f'), 'f2', 8_000_000),
      recording(alice, folderOf(alice, 'f'), 'f1', 7_000_000),
      observation(bob, 'b2', 6_000_000),
      observation(bob, 'b1', 5_000_000),
    ]

    it('says so on a group card that a later row can join when the row budget ends the page', () => {
      const { page } = fill(20, dump)

      const { items } = page.finish('budget')

      expect(groupsOf(items)).toMatchObject([{ kind: 'audio', more: true }])
    })

    it('says nothing when a full page or the end of the data ended it', () => {
      for (const stop of ['full', 'exhausted'] as const) {
        const [group] = groupsOf(fill(20, dump).page.finish(stop).items)
        expect(group).not.toHaveProperty('more')
      }
    })

    it('says so only on the newest card of a group that a gap split into two', () => {
      const folder = folderOf(alice, 'f')
      const { page } = fill(20, [
        recording(alice, folder, 'n3', 100 * HOUR),
        recording(alice, folder, 'n2', 99 * HOUR),
        recording(alice, folder, 'n1', 98 * HOUR),
        recording(alice, folder, 'o3', 50 * HOUR),
        recording(alice, folder, 'o2', 49 * HOUR),
        recording(alice, folder, 'o1', 48 * HOUR),
      ])

      const groups = groupsOf(page.finish('budget').items)

      // Rows after this page can only extend the card that is open: the older one.
      expect(groups.map((group) => [group.to, group.more])).toEqual([
        ['2026-03-05T04:00:00.000000Z', undefined],
        ['2026-03-03T02:00:00.000000Z', true],
      ])
    })

    it('says nothing on a group of fewer than three rows, which is shown as records', () => {
      const { items } = fill(20, dump.slice(0, 2)).page.finish('budget')

      expect(items.map(({ item }) => item)).not.toContainEqual(
        expect.objectContaining({ more: true }),
      )
    })

    // The budget ended the page at its last row. A card whose group could not
    // take a later row has nothing to continue, so it does not say more. A
    // later row is no newer than the last one, so the card is continued only
    // when the last row is within 12 hours of the card's oldest row.
    it('says so only on the card that a later row could still join', () => {
      const folder = folderOf(alice, 'f')
      // Three observations at the top, then 20 recordings one hour apart: the
      // last row is 20 hours after the observations' card.
      const rows = [
        observation(alice, 'o3', 20 * HOUR),
        observation(alice, 'o2', 20 * HOUR - 1_000_000),
        observation(alice, 'o1', 20 * HOUR - 2_000_000),
        ...Array.from({ length: 20 }, (_, index) =>
          recording(
            alice,
            folder,
            `a${String(19 - index).padStart(2, '0')}`,
            (19 - index) * HOUR,
          ),
        ),
      ]

      const groups = groupsOf(fill(20, rows).page.finish('budget').items)

      expect(
        groups.map(({ kind, total, more }) => [kind, total, more]),
      ).toEqual([
        ['observation', 3, undefined],
        ['audio', 20, true],
      ])
    })

    it.each([
      ['exactly 12 hours', 12 * HOUR, true],
      ['12 hours and a microsecond', 12 * HOUR + 1, false],
    ])(
      'measures from the card’s oldest row to the last consumed row: %s apart',
      (_name, gap, more) => {
        const rows = [
          observation(alice, 'o3', 100 * HOUR),
          observation(alice, 'o2', 100 * HOUR - 1_000_000),
          observation(alice, 'o1', 100 * HOUR - 2_000_000),
          post(bob, 'last', 100 * HOUR - 2_000_000 - gap),
        ]

        const [group] = groupsOf(fill(20, rows).page.finish('budget').items)

        expect(group?.more).toBe(more ? true : undefined)
      },
    )
  })

  describe('items', () => {
    it('names the folder only when it is a valid AT-URI, and still groups by the raw value', () => {
      const valid = folderOf(alice, 'f')
      const rows = (folder: string): FeedRow[] => [
        recording(alice, folder, 'a3', 3_000_000),
        recording(alice, folder, 'a2', 2_000_000),
        recording(alice, folder, 'a1', 1_000_000),
      ]

      const named = groupsOf(
        fill(5, rows(valid)).page.finish('exhausted').items,
      )
      expect(named[0]).toMatchObject({ did: alice, deployment: valid })
      for (const malformed of [
        'at://did:/x',
        `${valid}/`,
        `${valid}?x=1`,
        `${valid}#frag`,
        'at://',
      ]) {
        const [group] = groupsOf(
          fill(5, rows(malformed)).page.finish('exhausted').items,
        )
        expect(group, malformed).toMatchObject({ did: alice, total: 3 })
        expect(group, malformed).not.toHaveProperty('deployment')
      }
    })

    it('names the folder owner as the group’s account and each recording by the account that stored it', () => {
      const folder = folderOf(alice, 'f')
      const { page } = fill(5, [
        recording(alice, folder, 'm2', 3_000_000, bob),
        recording(alice, folder, 'm1', 2_000_000, bob),
        recording(alice, folder, 'own', 1_000_000),
      ])

      const { items } = page.finish('exhausted')

      expect(groupsOf(items)).toMatchObject([{ did: alice, total: 3 }])
      expect(items[0]?.uris).toEqual([
        `at://${bob}/app.gainforest.ac.audio/m2`,
        `at://${bob}/app.gainforest.ac.audio/m1`,
        `at://${alice}/app.gainforest.ac.audio/own`,
      ])
    })

    it('references the 20 newest rows of a card and lists every row in uris', () => {
      const rows = Array.from({ length: 45 }, (_, index) =>
        observation(
          alice,
          `o${String(index).padStart(2, '0')}`,
          (100 - index) * 1_000_000,
        ),
      )

      const [selected] = fill(5, rows).page.finish('exhausted').items
      const item = selected?.item

      expect(item).toMatchObject({ $type: GROUP_ITEM_TYPE, total: 45 })
      expect(item?.$type === GROUP_ITEM_TYPE ? item.subjects : []).toEqual(
        rows.slice(0, GROUP_SAMPLE_SIZE).map((row) => row.uri),
      )
      expect(selected?.uris).toEqual(rows.map((row) => row.uri))
    })

    it('gives the same group the same key on every page and different groups different keys', () => {
      const rows = (folder: string | null, owner: string) => [
        recording(owner, folder, 'c', 3_000_000),
        recording(owner, folder, 'b', 2_000_000),
        recording(owner, folder, 'a', 1_000_000),
      ]
      const keyOf = (input: readonly FeedRow[]): string | undefined =>
        groupsOf(fill(5, input).page.finish('exhausted').items)[0]?.groupKey
      const folder = folderOf(alice, 'f')

      const key = keyOf(rows(folder, alice))

      expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(keyOf(rows(folder, alice))).toBe(key)
      expect(keyOf(rows(folderOf(alice, 'g'), alice))).not.toBe(key)
      expect(keyOf(rows(null, alice))).not.toBe(key)
      expect(keyOf(rows(folder, bob))).not.toBe(key)
      expect(
        keyOf([
          observation(alice, 'c', 3_000_000),
          observation(alice, 'b', 2_000_000),
          observation(alice, 'a', 1_000_000),
        ]),
      ).not.toBe(keyOf(rows(null, alice)))
    })

    it('omits the cid Hyperindex has not stored and maps a recording to an audio record item', () => {
      const withoutCid: FeedRow[] = [
        { ...post(alice, 'p', 3_000_000), cid: null },
        { ...recording(alice, null, 'a', 2_000_000, bob), cid: null },
        {
          kind: 'repost',
          uri: `at://${alice}/app.gainforest.feed.repost/r`,
          cid: null,
          did: alice,
          subject: `at://${bob}/app.gainforest.feed.post/s`,
          ...timeAt(1_000_000),
        },
      ]

      const { items } = fill(5, withoutCid).page.finish('exhausted')

      expect(items.map(({ item }) => item)).toEqual([
        {
          $type: RECORD_ITEM_TYPE,
          kind: 'post',
          uri: `at://${alice}/app.gainforest.feed.post/p`,
          did: alice,
          createdAt: '2026-03-01T00:00:03.000000Z',
        },
        {
          $type: RECORD_ITEM_TYPE,
          kind: 'audio',
          uri: `at://${bob}/app.gainforest.ac.audio/a`,
          did: bob,
          createdAt: '2026-03-01T00:00:02.000000Z',
        },
        {
          $type: REPOST_ITEM_TYPE,
          uri: `at://${alice}/app.gainforest.feed.repost/r`,
          did: alice,
          createdAt: '2026-03-01T00:00:01.000000Z',
          subject: `at://${bob}/app.gainforest.feed.post/s`,
        },
      ])
    })
  })
})
