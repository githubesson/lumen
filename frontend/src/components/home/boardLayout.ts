/**
 * Where each Home panel sits on the board.
 *
 * The board is a six-column grid when wide (three visual columns, so a panel
 * can also take half the width) and two columns when medium; narrow boards
 * stack every panel in one column (that's CSS alone). Panels without content
 * are left out, and the ones that remain widen to close the gap, so the
 * board never shows holes: with everything present it's
 *
 *     Jump back in  Jump back in  On repeat
 *     Recently      Favorites     On repeat
 *     Albums        Albums        Playlists
 *     Top artists   Top artists   Top artists
 *
 * and on the medium board Jump back in, On repeat, Recently | Favorites,
 * Albums, Playlists | Top artists.
 *
 * Without On repeat (no plays in the last 30 days), Jump back in takes the
 * full width and the row lists (Recently played, Favorites, Playlists) share
 * one row under it. Without Jump back in (hidden), On repeat and the short
 * lists share the top row.
 *
 * That's the default board. A customized one (see homeArrangement.ts)
 * packs its panels by their own sizes instead (`packBoard`).
 */

/** Panels that hold lists and can be missing for want of one. */
export type BoardPanelId = "repeat" | "recent" | "favorites" | "albums" | "playlists" | "artists";

export interface BoardCell {
  /** The panel's id (on the default board, also its kind). */
  id: string;
  /** Columns it spans on the wide board, of six. */
  span: number;
  /** Rows it spans on the wide board. */
  rows: number;
  /** Columns it spans on the medium board, of two. */
  spanMd: number;
  /** Rows it spans on the medium board. */
  rowsMd: number;
  /**
   * Where it starts, as grid lines, on a packed board: the wide board's,
   * then the medium one's. The default board leaves placing to the grid.
   */
  col?: number;
  row?: number;
  colMd?: number;
  rowMd?: number;
}

const cell = (id: BoardPanelId | "resume", span: number, spanMd: number, rows = 1, rowsMd = 1): BoardCell => ({
  id,
  span,
  rows,
  spanMd,
  rowsMd,
});

/**
 * The panels to render, in order, with their spans. The order is also the
 * reading and focus order; the grid places them in it.
 */
export function boardLayout(present: Iterable<BoardPanelId | "resume">): BoardCell[] {
  const has = new Set(present);
  const only = (ids: BoardPanelId[]) => ids.filter((id) => has.has(id));
  const out: BoardCell[] = [];

  if (has.has("repeat")) {
    // On repeat runs down the right of Jump back in and the two short lists.
    // On the medium board it takes the full width instead (its rows flow
    // into two columns there) and the short lists pair up under it.
    const middle = only(["recent", "favorites"]);
    if (has.has("resume")) {
      out.push(cell("resume", 4, 2));
      out.push(cell("repeat", 2, 2, middle.length > 0 ? 2 : 1));
    } else {
      out.push(cell("repeat", middle.length > 0 ? 2 : 6, 2));
    }
    for (const id of middle) out.push(cell(id, 4 / middle.length, 2 / middle.length));
    const albums = has.has("albums");
    const playlists = has.has("playlists");
    // Medium: Playlists and Top artists pair up when both are there.
    const pair = playlists && has.has("artists");
    if (albums) out.push(cell("albums", playlists ? 4 : 6, 2));
    if (playlists) out.push(cell("playlists", albums ? 2 : 6, pair ? 1 : 2));
    if (has.has("artists")) out.push(cell("artists", 6, pair ? 1 : 2));
    return out;
  }

  if (has.has("resume")) out.push(cell("resume", 6, 2));
  const lists = only(["recent", "favorites", "playlists"]);
  lists.forEach((id, i) => {
    // Medium: in pairs, and an odd one out takes the full width.
    const alone = lists.length % 2 === 1 && i === lists.length - 1;
    out.push(cell(id, 6 / lists.length, alone ? 2 : 1));
  });
  for (const id of only(["albums", "artists"])) out.push(cell(id, 6, 2));
  return out;
}

export interface PackItem {
  id: string;
  /** Columns it asks for. */
  w: number;
  /** Rows it asks for. */
  h: number;
}

/** Where a packed panel went: its first column and row (from 0) and its spans. */
export interface Placement {
  id: string;
  col: number;
  row: number;
  w: number;
  h: number;
}

/**
 * Places panels on a grid of `columns` in order, by the sizes they ask for,
 * and leaves no holes. Each goes in the first place along its row where it
 * fits, as the grid itself would place it. A row is closed once the next
 * panel doesn't fit in what's left of it, and its gaps are filled: the
 * panels that start in the row widen into a gap beside them, sharing it out
 * so the narrowest grow first (two thirds side by side under a missing third
 * become halves). A gap with no such panel beside it, under panels from the
 * row above, has them grow down into it.
 *
 * Widening can't run into the next row: only panels that start in this row
 * reach it, and they sit in their own columns.
 */
export function packBoard(items: readonly PackItem[], columns: number): Placement[] {
  const placed: Placement[] = [];
  // Which panel (by index in `placed`) holds each cell, row by row.
  const grid: (number | null)[][] = [];
  const ensure = (row: number) => {
    while (grid.length <= row) grid.push(new Array<number | null>(columns).fill(null));
  };
  const paint = (i: number, value: number | null) => {
    const p = placed[i];
    ensure(p.row + p.h - 1);
    for (let r = p.row; r < p.row + p.h; r++) for (let c = p.col; c < p.col + p.w; c++) grid[r][c] = value;
  };
  const free = (row: number, col: number, w: number, h: number) => {
    ensure(row + h - 1);
    for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) if (grid[r][c] !== null) return false;
    return true;
  };
  const startsIn = (i: number | null | undefined, row: number): i is number => i != null && placed[i].row === row;

  // Lays `group` (side by side, in order) out across columns `from` to `to`.
  const spread = (group: number[], from: number, to: number) => {
    const widths = group.map((i) => placed[i].w);
    let extra = to - from + 1 - widths.reduce((sum, w) => sum + w, 0);
    while (extra-- > 0) {
      let narrowest = 0;
      widths.forEach((w, j) => {
        if (w < widths[narrowest]) narrowest = j;
      });
      widths[narrowest]++;
    }
    for (const i of group) paint(i, null);
    let col = from;
    group.forEach((i, j) => {
      placed[i].col = col;
      placed[i].w = widths[j];
      col += widths[j];
      paint(i, i);
    });
  };

  const fillGap = (row: number, a: number, b: number) => {
    const group: number[] = [];
    for (let c = a - 1; startsIn(grid[row][c], row); c = placed[group[0]].col - 1) group.unshift(grid[row][c]!);
    if (group.length > 0) return spread(group, placed[group[0]].col, b);
    for (let c = b + 1; startsIn(grid[row][c], row); c = placed[group[group.length - 1]].col + placed[group[group.length - 1]].w) {
      group.push(grid[row][c]!);
    }
    if (group.length > 0) {
      const last = placed[group[group.length - 1]];
      return spread(group, a, last.col + last.w - 1);
    }
    // Both sides are the edge or a panel from a row above, so the panels
    // above the gap span exactly it: they grow down into it.
    const above = new Set<number>();
    for (let c = a; c <= b; c++) {
      const i = grid[row - 1]?.[c];
      if (i != null) above.add(i);
    }
    for (const i of above) {
      placed[i].h += 1;
      paint(i, i);
    }
  };

  const closeRow = (row: number) => {
    ensure(row);
    for (let c = 0; c < columns; c++) {
      if (grid[row][c] !== null) continue;
      let b = c;
      while (b + 1 < columns && grid[row][b + 1] === null) b++;
      fillGap(row, c, b);
      c = b;
    }
  };

  let row = 0;
  let col = 0;
  for (const item of items) {
    const w = Math.max(1, Math.min(item.w, columns));
    const h = Math.max(1, item.h);
    for (;;) {
      let c = col;
      while (c + w <= columns && !free(row, c, w, h)) c++;
      if (c + w <= columns) {
        placed.push({ id: item.id, col: c, row, w, h });
        paint(placed.length - 1, placed.length - 1);
        col = c + w;
        break;
      }
      closeRow(row);
      row++;
      col = 0;
    }
  }
  for (let r = row; r < grid.length; r++) closeRow(r);
  return placed;
}

/** A panel's width on the medium board: half for a third or half, else all of it. */
export const mediumWidth = (w: number) => (w >= 4 ? 2 : 1);

/** A customized board: its panels packed by their sizes, on the wide board and the medium one. */
export function packedLayout(items: readonly PackItem[]): BoardCell[] {
  const wide = packBoard(items, 6);
  const medium = packBoard(
    items.map((item) => ({ ...item, w: mediumWidth(item.w) })),
    2,
  );
  return items.map((item, i) => ({
    id: item.id,
    span: wide[i].w,
    rows: wide[i].h,
    col: wide[i].col + 1,
    row: wide[i].row + 1,
    spanMd: medium[i].w,
    rowsMd: medium[i].h,
    colMd: medium[i].col + 1,
    rowMd: medium[i].row + 1,
  }));
}
