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
 * The ids name slots: a customized Home (see homeArrangement.ts) fills
 * them with other panels, and they keep these shapes.
 */

/** Panels that hold lists and can be missing for want of one. */
export type BoardPanelId = "repeat" | "recent" | "favorites" | "albums" | "playlists" | "artists";

export interface BoardCell {
  id: BoardPanelId | "resume";
  /** Columns it spans on the wide board, of six. */
  span: number;
  /** Rows it spans on the wide board. */
  rows: number;
  /** Columns it spans on the medium board, of two. */
  spanMd: number;
  /** Rows it spans on the medium board. */
  rowsMd: number;
}

const cell = (id: BoardCell["id"], span: number, spanMd: number, rows = 1, rowsMd = 1): BoardCell => ({
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
export function boardLayout(present: Iterable<BoardCell["id"]>): BoardCell[] {
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
