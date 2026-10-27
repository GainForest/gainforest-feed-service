import { createHash } from 'node:crypto'

import { isAtUriString } from '@atproto/syntax'

import type { FeedPosition, SelectedItem, SelectedPage } from './sql-feed.js'
import {
  GROUP_ITEM_TYPE,
  GROUP_SAMPLE_SIZE,
  MIN_GROUP_ROWS,
  RECORD_ITEM_TYPE,
  REPOST_ITEM_TYPE,
  type GroupKind,
} from './types.js'

/**
 * Longest gap between a row and the group's previous row, which is the oldest
 * row the group's open card holds so far. A gap of exactly this joins.
 */
const GROUP_MAX_GAP_MICROS = 12 * 60 * 60 * 1_000_000

/** Whether a row, no newer than the card's oldest row, is near enough to join it. */
const isNear = (card: { readonly oldest: FeedRow }, row: FeedRow): boolean =>
  card.oldest.micros - row.micros <= GROUP_MAX_GAP_MICROS

interface RowBase {
  readonly uri: string
  readonly cid: string | null
  /** The account that stored the record. */
  readonly did: string
  /** createdAt as the statement formats it; it is the item's `createdAt`. */
  readonly sortValue: string
  /** createdAt in microseconds since the epoch, for the gap rule. */
  readonly micros: number
}

/** One row of the feed statement, with the invariants of its kind already checked. */
export type FeedRow =
  | (RowBase & { readonly kind: 'project' | 'organization' | 'post' })
  | (RowBase & {
      readonly kind: 'observation'
      readonly bioacoustic: boolean
    })
  | (RowBase & {
      readonly kind: 'audio'
      /** Owner of the recording's folder; the recording's own account without one. */
      readonly owner: string
      readonly folder: string | null
    })
  | (RowBase & { readonly kind: 'repost'; readonly subject: string })

/** Why a page stopped taking rows. */
export type PageStop =
  /** The page has its cards and the next row would start another. */
  | 'full'
  /** The request used its whole row budget. */
  | 'budget'
  /** The statement had no more rows. */
  | 'exhausted'

/** What rows of one kind share when they belong together. */
interface Group {
  /** Identifies the group inside a page and, hashed, across pages. */
  readonly id: string
  readonly kind: GroupKind
  readonly owner: string
  readonly folder: string | null
}

interface PlacedRow {
  readonly row: FeedRow
  /** Position among the rows the page consumed. */
  readonly at: number
}

interface Card {
  readonly group: Group | undefined
  /** Newest first. */
  readonly rows: [PlacedRow, ...PlacedRow[]]
  /** The oldest row so far: the next row of the group must be near this one. */
  oldest: FeedRow
}

type GroupCard = Card & { readonly group: Group }

const groupFor = (
  kind: GroupKind,
  owner: string,
  folder: string | null,
): Group => ({
  id: JSON.stringify([kind, owner, folder]),
  kind,
  owner,
  folder,
})

/**
 * The group a row belongs to. Audio groups by owner and folder, and
 * observations by account. Every other row, and a bioacoustic sighting, which
 * is shown on its own with its spectrogram, stands alone.
 */
const groupOf = (row: FeedRow): Group | undefined => {
  switch (row.kind) {
    case 'audio':
      return groupFor('audio', row.owner, row.folder)
    case 'observation':
      return row.bioacoustic
        ? undefined
        : groupFor('observation', row.did, null)
    case 'project':
    case 'organization':
    case 'post':
    case 'repost':
      return undefined
  }
}

const groupKeyOf = (group: Group): string =>
  createHash('sha256').update(group.id).digest('base64url').slice(0, 22)

const isGroupCard = (card: Card): card is GroupCard =>
  card.group !== undefined && card.rows.length >= MIN_GROUP_ROWS

const optionalCid = (row: FeedRow): { readonly cid?: string } =>
  row.cid === null ? {} : { cid: row.cid }

const singleItem = (row: FeedRow): SelectedItem => ({
  item:
    row.kind === 'repost'
      ? {
          $type: REPOST_ITEM_TYPE,
          uri: row.uri,
          ...optionalCid(row),
          did: row.did,
          createdAt: row.sortValue,
          subject: row.subject,
        }
      : {
          $type: RECORD_ITEM_TYPE,
          kind: row.kind,
          uri: row.uri,
          ...optionalCid(row),
          did: row.did,
          createdAt: row.sortValue,
        },
  uris: [row.uri],
})

/**
 * The group's `deployment`, when the response can name its folder. The field
 * has `format: at-uri`, and the output check applies the same strict test as
 * `isAtUriString`. One `deploymentRef` that fails it would fail every page
 * that holds the recording with a 500, so such a folder is left out. The
 * recordings still group by it.
 */
const deploymentOf = (group: Group): { readonly deployment?: string } =>
  group.folder !== null && isAtUriString(group.folder)
    ? { deployment: group.folder }
    : {}

const groupItem = (card: GroupCard, more: boolean): SelectedItem => {
  const uris = card.rows.map(({ row }) => row.uri)
  return {
    item: {
      $type: GROUP_ITEM_TYPE,
      kind: card.group.kind,
      did: card.group.owner,
      ...deploymentOf(card.group),
      groupKey: groupKeyOf(card.group),
      total: card.rows.length,
      from: card.oldest.sortValue,
      to: card.rows[0].row.sortValue,
      subjects: uris.slice(0, GROUP_SAMPLE_SIZE),
      ...(more ? { more: true } : {}),
    },
    uris,
  }
}

/**
 * Folds feed rows, newest first, into the cards of one page.
 *
 * A row of a group joins the group's open card when it is within 12 hours of
 * that card's oldest row, whatever other rows lie between them. Any other row
 * starts a card: of its group, which then becomes the open one, or of its own.
 * A page takes `limit` cards. It ends at the first row that would start
 * another, so every consumed row is in exactly one item and the next page
 * starts at the row after the last consumed one.
 *
 * `limit` counts cards while the page is built. A group card that ends with
 * fewer than `MIN_GROUP_ROWS` rows is shown as its separate records instead,
 * each at its own position among the page's rows, so a page can hold up to
 * twice `limit` items. It holds fewer when the data or the request's row
 * budget ends the page first.
 */
export class PageBuilder {
  readonly #limit: number
  readonly #cards: Card[] = []
  readonly #open = new Map<string, Card>()
  #consumed = 0
  #last: FeedRow | undefined
  #full = false

  constructor(limit: number) {
    this.#limit = limit
  }

  /** The last row the page consumed: where the next statement and page start. */
  get last(): FeedPosition | undefined {
    return this.#last === undefined
      ? undefined
      : { sortValue: this.#last.sortValue, uri: this.#last.uri }
  }

  /**
   * Takes the next row of the feed, in feed order. Returns false, and takes
   * nothing, when the row would start a card the page has no room for. The
   * page is then full: it takes no row after that, so what it consumed is
   * always the rows up to one position.
   */
  accept(row: FeedRow): boolean {
    if (this.#full) return false
    this.#assertNewestFirst(row)

    const group = groupOf(row)
    const open = this.#cardToJoin(group, row)
    if (open === undefined && this.#cards.length >= this.#limit) {
      this.#full = true
      return false
    }

    const placed = { row, at: this.#consumed }
    if (open === undefined) {
      const card: Card = { group, rows: [placed], oldest: row }
      this.#cards.push(card)
      if (group !== undefined) this.#open.set(group.id, card)
    } else {
      open.rows.push(placed)
      open.oldest = row
    }
    this.#consumed += 1
    this.#last = row
    return true
  }

  /** The group's open card, when the row is near enough to its oldest row to join it. */
  #cardToJoin(group: Group | undefined, row: FeedRow): Card | undefined {
    const open = group === undefined ? undefined : this.#open.get(group.id)
    return open !== undefined && isNear(open, row) ? open : undefined
  }

  /**
   * Whether a row after the last consumed one could still join the card: the
   * card is its group's open card, and the last consumed row, which no later
   * row is newer than, is within 12 hours of the card's oldest row. When it
   * is not, the group's next row starts a new card, whatever the group does.
   */
  #canBeContinued(card: GroupCard): boolean {
    return (
      this.#last !== undefined &&
      this.#open.get(card.group.id) === card &&
      isNear(card, this.#last)
    )
  }

  #assertNewestFirst(row: FeedRow): void {
    if (this.#last !== undefined && row.micros > this.#last.micros) {
      throw new Error(
        `Activity feed query invariant failed: row ${row.uri} is newer than the row before it; verify the SQL ordering before serving feed requests.`,
      )
    }
  }

  /**
   * Builds the page. `next` is the last consumed row unless the data ended.
   * On a budget stop, a group card says `more` when the next page can still
   * continue it (see `#canBeContinued`). No other stop says it, and the
   * absence of `more` does not mean that the group is complete.
   */
  finish(stop: PageStop): SelectedPage {
    const placed = this.#cards.flatMap((card) =>
      isGroupCard(card)
        ? [
            {
              at: card.rows[0].at,
              selected: groupItem(
                card,
                stop === 'budget' && this.#canBeContinued(card),
              ),
            },
          ]
        : card.rows.map(({ row, at }) => ({ at, selected: singleItem(row) })),
    )
    placed.sort((a, b) => a.at - b.at)

    const next = this.last
    return {
      items: placed.map(({ selected }) => selected),
      ...(stop === 'exhausted' || next === undefined ? {} : { next }),
    }
  }
}
