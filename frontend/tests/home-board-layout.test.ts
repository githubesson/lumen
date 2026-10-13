import { describe, expect, it } from "vitest";
import { boardLayout, type BoardCell } from "../src/components/home/boardLayout";
import { homeAlbums } from "../src/components/home/homeAlbums";
import {
  DEFAULT_ARRANGEMENT,
  HOME_PANELS,
  arrangementTweak,
  isDefaultArrangement,
  panelIn,
  readArrangement,
  setPanelHidden,
  swapPanels,
} from "../src/components/home/homeArrangement";
import type { TrackListItem } from "../src/api";

const ALL: BoardCell["id"][] = ["resume", "repeat", "recent", "favorites", "albums", "playlists", "artists"];

/**
 * CSS grid's sparse auto-placement, for spans only: each cell goes at the
 * first spot at or after the previous one where it fits. Returns the rows,
 * each a list of the panel ids in its columns (null for a hole).
 */
function place(cells: BoardCell[], columns: number, medium: boolean): (string | null)[][] {
  const grid: (string | null)[][] = [];
  const at = (r: number, c: number) => (grid[r] ??= Array<string | null>(columns).fill(null))[c];
  let row = 0;
  let col = 0;
  for (const cell of cells) {
    const span = medium ? cell.spanMd : cell.span;
    const rows = medium ? cell.rowsMd : cell.rows;
    const fits = () => {
      for (let r = row; r < row + rows; r++) for (let c = col; c < col + span; c++) if (at(r, c) !== null) return false;
      return true;
    };
    for (;;) {
      if (col + span > columns) {
        row++;
        col = 0;
      } else if (fits()) break;
      else col++;
    }
    for (let r = row; r < row + rows; r++) for (let c = col; c < col + span; c++) grid[r][c] = cell.id;
    col += span;
  }
  return grid;
}

const subsets = <T,>(ids: T[]): T[][] => ids.reduce<T[][]>((acc, id) => [...acc, ...acc.map((s) => [...s, id])], [[]]);

describe("boardLayout", () => {
  it("lays out a full board like the Board mock", () => {
    const cells = boardLayout(ALL);
    expect(place(cells, 6, false)).toEqual([
      ["resume", "resume", "resume", "resume", "repeat", "repeat"],
      ["recent", "recent", "favorites", "favorites", "repeat", "repeat"],
      ["albums", "albums", "albums", "albums", "playlists", "playlists"],
      ["artists", "artists", "artists", "artists", "artists", "artists"],
    ]);
    expect(place(cells, 2, true)).toEqual([
      ["resume", "resume"],
      ["repeat", "repeat"],
      ["recent", "favorites"],
      ["albums", "albums"],
      ["playlists", "artists"],
    ]);
  });

  it("gives the lists one row under a full-width Jump back in without plays this month", () => {
    const cells = boardLayout(["resume", "recent", "favorites", "albums", "playlists"]);
    expect(place(cells, 6, false)).toEqual([
      Array(6).fill("resume"),
      ["recent", "recent", "favorites", "favorites", "playlists", "playlists"],
      Array(6).fill("albums"),
    ]);
    expect(place(cells, 2, true)).toEqual([
      ["resume", "resume"],
      ["recent", "favorites"],
      ["playlists", "playlists"],
      ["albums", "albums"],
    ]);
  });

  it("leaves Jump back in alone for an empty library", () => {
    expect(boardLayout(["resume"])).toEqual([{ id: "resume", span: 6, rows: 1, spanMd: 2, rowsMd: 1 }]);
  });

  it("gives On repeat and the short lists the top row when Jump back in is hidden", () => {
    const cells = boardLayout(ALL.filter((id) => id !== "resume"));
    expect(place(cells, 6, false)).toEqual([
      ["repeat", "repeat", "recent", "recent", "favorites", "favorites"],
      ["albums", "albums", "albums", "albums", "playlists", "playlists"],
      Array(6).fill("artists"),
    ]);
  });

  it("never leaves a hole, whichever panels are missing", () => {
    for (const present of subsets(ALL)) {
      const cells = boardLayout(present);
      expect(cells.map((c) => c.id).sort()).toEqual([...present].sort());
      for (const [columns, medium] of [[6, false], [2, true]] as const) {
        const grid = place(cells, columns, medium);
        expect(grid.flat(), `${present.join(",") || "nothing"} at ${columns} columns`).not.toContain(null);
      }
    }
  });
});

describe("home arrangement", () => {
  it("swaps two panels' slots, and hides and shows a panel in place", () => {
    const swapped = swapPanels(DEFAULT_ARRANGEMENT, "albums", "recent");
    expect(panelIn(swapped, "recent")).toBe("albums");
    expect(panelIn(swapped, "albums")).toBe("recent");
    expect(swapPanels(swapped, "recent", "albums")).toEqual(DEFAULT_ARRANGEMENT);

    const hidden = setPanelHidden(swapped, "albums", true);
    expect([...hidden.hidden]).toEqual(["albums"]);
    expect(panelIn(hidden, "recent")).toBe("albums");
    expect(isDefaultArrangement(setPanelHidden(setPanelHidden(DEFAULT_ARRANGEMENT, "albums", true), "albums", false))).toBe(true);
  });

  it("saves nothing for the default, and reads back what it saved", () => {
    expect(arrangementTweak(DEFAULT_ARRANGEMENT)).toBeUndefined();
    const arranged = setPanelHidden(swapPanels(DEFAULT_ARRANGEMENT, "resume", "artists"), "favorites", true);
    const saved = arrangementTweak(arranged)!;
    expect(saved).toEqual({
      slots: ["artists", "repeat", "recent", "favorites", "albums", "playlists", "resume"],
      hidden: ["favorites"],
    });
    expect(readArrangement(JSON.parse(JSON.stringify(saved)))).toEqual(arranged);
  });

  it("repairs a stale or broken save without losing or doubling a panel", () => {
    // A panel this build doesn't know, one listed twice, and one missing.
    const read = readArrangement({
      slots: ["artists", "radio", "artists", "recent", "albums", "favorites"],
      hidden: ["radio", "albums"],
    });
    expect(read.slots).toEqual(["artists", "resume", "repeat", "recent", "albums", "favorites", "playlists"]);
    expect([...read.hidden]).toEqual(["albums"]);
    expect([...read.slots].sort()).toEqual([...HOME_PANELS].sort());
    expect(readArrangement(undefined)).toBe(DEFAULT_ARRANGEMENT);
    expect(readArrangement({ slots: "nope", hidden: null } as never)).toEqual(DEFAULT_ARRANGEMENT);
  });
});

describe("homeAlbums", () => {
  const track = (id: string, album: string | undefined, artist: string, extra: Partial<TrackListItem> = {}): TrackListItem => ({
    id,
    title: id,
    duration_ms: 1,
    source: "local",
    album_id: album,
    album_title: album ? `Album ${album}` : undefined,
    artist,
    ...extra,
  });

  it("lists each album once, in the order its first track comes", () => {
    const albums = homeAlbums([
      track("1", "b", "Kestrel Bay"),
      track("2", "a", "Halden Marsh"),
      track("3", "b", "Kestrel Bay"),
    ]);
    expect(albums.map((a) => a.id)).toEqual(["b", "a"]);
  });

  it("keeps a track with a featured guest on its album, under the album's usual artist", () => {
    const albums = homeAlbums([
      track("1", "a", "Halden Marsh, Hana Okoro"),
      track("2", "a", "Halden Marsh"),
      track("3", "a", "Halden Marsh"),
    ]);
    expect(albums).toEqual([{ id: "a", title: "Album a", artist: "Halden Marsh" }]);
  });

  it("skips tracks without a library album to open", () => {
    const albums = homeAlbums([
      track("loose", undefined, "Kestrel Bay"),
      // A streamed TIDAL track's album id is a hidden one.
      track("tidal", "hidden", "Kestrel Bay", { source: "tidal", source_album_id: "77" }),
      track("1", "a", ""),
    ]);
    expect(albums).toEqual([{ id: "a", title: "Album a", artist: "Unknown artist" }]);
  });
});
