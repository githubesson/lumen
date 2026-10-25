import { movePlaylistEntry } from "@music-library/core";

/**
 * Drops from react-native-reorderable-list, checked against the rows a list
 * holds when they land.
 *
 * The list reports a drop as indices into the rows it showed when the drag
 * began, one drop animation after the finger lifts. A refetch can replace
 * those rows in the meantime, so the indices may point at other rows, or past
 * the end of a shorter list.
 */

export type ReorderMove = { from: number; to: number };

/** Whether `index` is a slot in `list`. */
export function isIndexIn(list: readonly unknown[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < list.length;
}

/**
 * A list key for a row that may be missing. The list library reads keys by
 * index, and a stale index past the end of the data hands it `undefined`.
 */
export function rowKeyOrIndex(row: { key: string } | undefined, index: number): string {
  return row?.key ?? String(index);
}

/**
 * `keys` with each repeat numbered in list order ("k", "k#1", "k#2"), so rows
 * that share a key still get distinct ones.
 */
export function numberRepeatedKeys(keys: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map((key) => {
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? key : `${key}#${count}`;
  });
}

/**
 * The move a drop makes on `current`, where `from` and `to` index `dragged`
 * (the row keys the drag began on). The dragged row goes under the row it
 * was dropped under; when that row is gone, or the drop was at the top, it
 * goes above the row it was dropped above. Null when there's nothing to
 * move: an index outside `dragged`, a dragged row that's gone, no neighbour
 * left to place it by, or a row already where the drop puts it. Keys must
 * be unique (see `numberRepeatedKeys`).
 */
export function rebaseDrop(
  dragged: readonly string[],
  current: readonly string[],
  from: number,
  to: number,
): ReorderMove | null {
  if (from === to || !isIndexIn(dragged, from) || !isIndexIn(dragged, to)) return null;
  const fromNow = current.indexOf(dragged[from]);
  if (fromNow < 0) return null;
  // Both lists without the dragged row: the drop puts it between
  // others[to - 1] and others[to], and the move's `to` indexes `rest` the
  // same way (out first, then back in).
  const others = dragged.filter((_, i) => i !== from);
  const rest = current.filter((_, i) => i !== fromNow);
  const below = to > 0 ? rest.indexOf(others[to - 1]) : -1;
  const above = below < 0 && to < others.length ? rest.indexOf(others[to]) : -1;
  const toNow = below >= 0 ? below + 1 : above;
  if (toNow < 0 || toNow === fromNow) return null;
  return { from: fromNow, to: toNow };
}

/**
 * The playlist after moving the row at `from` to `to`, or null unless both
 * are distinct slots in `entries`: a reorder built from an index outside the
 * list would send the server an undefined track id.
 */
export function playlistAfterDrop<T extends { position: number }>(
  entries: readonly T[],
  from: number,
  to: number,
): T[] | null {
  if (from === to || !isIndexIn(entries, from) || !isIndexIn(entries, to)) return null;
  return movePlaylistEntry(entries, from, to);
}
