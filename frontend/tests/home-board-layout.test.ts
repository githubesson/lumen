import { describe, expect, it } from "vitest";
import {
  boardLayout,
  mediumWidth,
  packBoard,
  packedLayout,
  type BoardCell,
  type BoardPanelId,
  type PackItem,
  type Placement,
} from "../src/components/home/boardLayout";
import { homeAlbums } from "../src/components/home/homeAlbums";
import {
  DEFAULT_ARRANGEMENT,
  DEFAULT_PANEL_IDS,
  MAX_PANELS,
  addPanel,
  arrangementTweak,
  defaultSlots,
  findPanel,
  isDefaultArrangement,
  readArrangement,
  removePanel,
  setPanelHidden,
  swapPanels,
  updatePanel,
  type HomeArrangement,
} from "../src/components/home/homeArrangement";
import { PANEL_HEIGHTS, PANEL_WIDTHS } from "../src/components/home/panelKinds";
import type { TrackListItem } from "../src/api";

const ALL: (BoardPanelId | "resume")[] = ["resume", "repeat", "recent", "favorites", "albums", "playlists", "artists"];

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

/** The rows a packing fills, each a list of panel ids by column; throws on an overlap. */
function gridOf(placements: Placement[], columns: number): (string | null)[][] {
  const grid: (string | null)[][] = [];
  for (const p of placements) {
    for (let r = p.row; r < p.row + p.h; r++) {
      grid[r] ??= Array<string | null>(columns).fill(null);
      for (let c = p.col; c < p.col + p.w; c++) {
        if (c >= columns || grid[r][c] !== null) throw new Error(`${p.id} overlaps at ${r},${c}`);
        grid[r][c] = p.id;
      }
    }
  }
  return Array.from(grid, (row) => row ?? Array<string | null>(columns).fill(null));
}

const sizes = (arrangement: HomeArrangement): PackItem[] =>
  arrangement.panels.filter((p) => !p.hidden).map(({ id, w, h }) => ({ id, w, h }));

describe("packBoard", () => {
  it("packs the default panels into the default board's full shape", () => {
    const placed = packBoard(sizes(DEFAULT_ARRANGEMENT), 6);
    expect(gridOf(placed, 6)).toEqual(place(boardLayout(ALL), 6, false));
    // Placed where the grid would put them, so CSS and the packing agree.
    const cells = packedLayout(sizes(DEFAULT_ARRANGEMENT));
    expect(cells.map(({ id, span, rows }) => ({ id, span, rows }))).toEqual(
      boardLayout(ALL).map(({ id, span, rows }) => ({ id, span, rows })),
    );
  });

  it("widens the panels a row closes on, the narrowest first", () => {
    // Two thirds and a full-width panel that doesn't fit beside them.
    const two = packBoard([{ id: "a", w: 2, h: 1 }, { id: "b", w: 2, h: 1 }, { id: "c", w: 6, h: 1 }], 6);
    expect(gridOf(two, 6)).toEqual([
      ["a", "a", "a", "b", "b", "b"],
      Array(6).fill("c"),
    ]);
    // A third beside a half: they come out halves.
    expect(gridOf(packBoard([{ id: "a", w: 2, h: 1 }, { id: "b", w: 3, h: 1 }], 6), 6)).toEqual([
      ["a", "a", "a", "b", "b", "b"],
    ]);
    // The last row closes too.
    expect(gridOf(packBoard([{ id: "a", w: 4, h: 1 }], 6), 6)).toEqual([Array(6).fill("a")]);
  });

  it("has the panels above grow into a gap beside a tall one", () => {
    const placed = packBoard([{ id: "a", w: 4, h: 1 }, { id: "tall", w: 2, h: 2 }, { id: "c", w: 6, h: 1 }], 6);
    expect(gridOf(placed, 6)).toEqual([
      ["a", "a", "a", "a", "tall", "tall"],
      ["a", "a", "a", "a", "tall", "tall"],
      Array(6).fill("c"),
    ]);
  });

  it("widens a tall panel with the row it starts in", () => {
    const placed = packBoard([{ id: "tall", w: 2, h: 2 }, { id: "b", w: 2, h: 1 }, { id: "c", w: 6, h: 1 }], 6);
    expect(gridOf(placed, 6)).toEqual([
      ["tall", "tall", "tall", "b", "b", "b"],
      ["tall", "tall", "tall", "b", "b", "b"],
      Array(6).fill("c"),
    ]);
  });

  it("never leaves a hole or loses a panel, whatever their sizes", () => {
    const shapes = PANEL_WIDTHS.flatMap((w) => PANEL_HEIGHTS.map((h) => ({ w, h })));
    const failures: string[] = [];
    let boards: PackItem[][] = [[]];
    for (let length = 1; length <= 5; length++) {
      boards = boards.flatMap((board) => shapes.map((shape) => [...board, { id: `p${length}`, ...shape }]));
      for (const board of boards) {
        for (const columns of [6, 2]) {
          const items = columns === 2 ? board.map((item) => ({ ...item, w: mediumWidth(item.w) })) : board;
          const placed = packBoard(items, columns);
          const ok =
            placed.every((p, i) => p.id === items[i].id && p.w >= items[i].w && p.h >= items[i].h) &&
            placed.length === items.length &&
            !gridOf(placed, columns).flat().includes(null);
          if (!ok) failures.push(`${board.map((i) => `${i.w}x${i.h}`).join(" ")} on ${columns}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("home arrangement", () => {
  it("swaps two panels' places, the sizes staying put, and hides and shows a panel in place", () => {
    const swapped = swapPanels(DEFAULT_ARRANGEMENT, "resume", "repeat");
    expect(swapped.panels.map((p) => `${p.id} ${p.w}x${p.h}`).slice(0, 2)).toEqual(["repeat 4x1", "resume 2x2"]);
    expect(swapPanels(swapped, "repeat", "resume")).toEqual(DEFAULT_ARRANGEMENT);

    const hidden = setPanelHidden(swapped, "albums", true);
    expect(hidden.panels.filter((p) => p.hidden).map((p) => p.id)).toEqual(["albums"]);
    expect(hidden.panels.map((p) => p.id)).toEqual(swapped.panels.map((p) => p.id));
    expect(isDefaultArrangement(setPanelHidden(setPanelHidden(DEFAULT_ARRANGEMENT, "albums", true), "albums", false))).toBe(true);
  });

  it("adds panels of a kind under ids of their own, and shows a hidden one rather than adding it twice", () => {
    const first = addPanel(DEFAULT_ARRANGEMENT, "repeat", { period: { kind: "all" } });
    expect(first.id).toBe("repeat-2");
    const second = addPanel(first.arrangement, "repeat");
    expect(second.id).toBe("repeat-3");
    expect(findPanel(second.arrangement, "repeat-2")).toMatchObject({ kind: "repeat", w: 2, h: 2, period: { kind: "all" } });
    expect(findPanel(second.arrangement, "repeat-3")!.period).toEqual({ kind: "last-30" });
    // Removing one frees its id for the next.
    expect(addPanel(removePanel(second.arrangement, "repeat-2"), "repeat").id).toBe("repeat-2");

    const hidden = setPanelHidden(DEFAULT_ARRANGEMENT, "recent", true);
    const shown = addPanel(hidden, "recent");
    expect(shown.id).toBe("recent");
    expect(shown.arrangement.panels).toHaveLength(7);
    expect(isDefaultArrangement(shown.arrangement)).toBe(true);
    // Already on the board: nothing to add.
    expect(addPanel(DEFAULT_ARRANGEMENT, "recent").arrangement).toEqual(DEFAULT_ARRANGEMENT);

    let full = DEFAULT_ARRANGEMENT;
    while (full.panels.length < MAX_PANELS) full = addPanel(full, "stats").arrangement;
    expect(addPanel(full, "genres")).toEqual({ arrangement: full, id: null });
  });

  it("renames a panel, and an emptied name goes back to its kind's", () => {
    const named = updatePanel(DEFAULT_ARRANGEMENT, "repeat", { title: "  Heavy   rotation " });
    expect(findPanel(named, "repeat")!.title).toBe("Heavy rotation");
    expect(isDefaultArrangement(named)).toBe(false);
    const cleared = updatePanel(named, "repeat", { title: "   " });
    expect(findPanel(cleared, "repeat")!.title).toBeUndefined();
    expect(isDefaultArrangement(cleared)).toBe(true);
  });

  it("saves nothing for the default, and reads back what it saved", () => {
    expect(arrangementTweak(DEFAULT_ARRANGEMENT)).toBeUndefined();
    let arranged = setPanelHidden(swapPanels(DEFAULT_ARRANGEMENT, "resume", "artists"), "favorites", true);
    arranged = addPanel(arranged, "playlist", { playlist: "pl-1" }).arrangement;
    arranged = addPanel(arranged, "genres", { period: { kind: "year", year: 2024 } }).arrangement;
    arranged = updatePanel(arranged, "artists", { title: "Who I play", w: 3 });
    const saved = arrangementTweak(arranged)!;
    expect(saved.panels!.slice(-2)).toEqual([
      { id: "playlist", kind: "playlist", w: 2, h: 1, playlist: "pl-1" },
      { id: "genres", kind: "genres", w: 2, h: 1, period: "year:2024" },
    ]);
    expect(saved.panels![0]).toEqual({ id: "artists", kind: "artists", w: 3, h: 1, title: "Who I play", period: "last-30" });
    expect(saved.panels![3]).toMatchObject({ id: "favorites", hidden: true });
    expect(readArrangement(JSON.parse(JSON.stringify(saved)))).toEqual(arranged);
  });

  it("reads the first build's slots, each panel taking its slot's shape", () => {
    const read = readArrangement({
      slots: ["repeat", "resume", "recent", "favorites", "albums", "playlists", "artists"],
      hidden: ["favorites"],
    });
    expect(read.panels.map((p) => `${p.id} ${p.w}x${p.h}${p.hidden ? " hidden" : ""}`)).toEqual([
      "repeat 4x1",
      "resume 2x2",
      "recent 2x1",
      "favorites 2x1 hidden",
      "albums 4x1",
      "playlists 2x1",
      "artists 6x1",
    ]);
    // A panel this build doesn't know, one listed twice, and one missing.
    const repaired = readArrangement({
      slots: ["artists", "radio", "artists", "recent", "albums", "favorites"],
      hidden: ["radio", "albums"],
    });
    expect(repaired.panels.map((p) => p.id)).toEqual(["artists", "resume", "repeat", "recent", "albums", "favorites", "playlists"]);
    expect(repaired.panels.filter((p) => p.hidden).map((p) => p.id)).toEqual(["albums"]);
    expect(readArrangement({ slots: [], hidden: [] })).toEqual(DEFAULT_ARRANGEMENT);
  });

  it("repairs a stale or broken save without showing a panel twice", () => {
    const read = readArrangement({
      panels: [
        { id: "resume", kind: "resume", w: 4, h: 1 },
        { id: "resume", kind: "resume", w: 4, h: 1 },
        { id: "radio", kind: "radio", w: 2, h: 1 },
        { id: "repeat", kind: "repeat", w: 5, h: 9, period: "yesterday", title: "x".repeat(80) },
        { id: "repeat", kind: "repeat", w: 2, h: 1 },
        { id: "repeat-1", kind: "repeat", w: 2, h: 1 },
        { id: "playlist", kind: "playlist", w: 2, h: 1 },
        { id: "<script>", kind: "playlist", w: 2, h: 1, playlist: "pl-9" },
        null as never,
      ],
    });
    expect(read.panels.map((p) => p.id)).toEqual(["resume", "repeat", "repeat-2", "repeat-3", "playlist"]);
    expect(read.panels[1]).toMatchObject({ w: 2, h: 2, period: { kind: "last-30" } });
    expect(read.panels[1].title).toHaveLength(60);
    expect(read.panels[4].playlist).toBe("pl-9");
    expect(readArrangement({ panels: Array.from({ length: 40 }, () => ({ id: "x", kind: "stats", w: 2, h: 1 })) }).panels).toHaveLength(MAX_PANELS);
    // Every panel removed is a board of its own, not the default.
    expect(readArrangement({ panels: [] }).panels).toEqual([]);
    expect(readArrangement(undefined)).toBe(DEFAULT_ARRANGEMENT);
    expect(readArrangement({ slots: "nope", hidden: null } as never)).toEqual(DEFAULT_ARRANGEMENT);
    expect(DEFAULT_ARRANGEMENT.panels.map((p) => p.id)).toEqual([...DEFAULT_PANEL_IDS]);
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

describe("defaultSlots", () => {
  it("keeps the default board's slots through swaps, hides and renames, not resizes or new panels", () => {
    const swapped = setPanelHidden(swapPanels(DEFAULT_ARRANGEMENT, "albums", "resume"), "repeat", true);
    expect(defaultSlots(updatePanel(swapped, "recent", { title: "Lately" }))!.map((p) => p.id)).toEqual([
      "albums", "repeat", "recent", "favorites", "resume", "playlists", "artists",
    ]);
    expect(defaultSlots(updatePanel(DEFAULT_ARRANGEMENT, "recent", { w: 3 }))).toBeNull();
    expect(defaultSlots(addPanel(DEFAULT_ARRANGEMENT, "stats").arrangement)).toBeNull();
    expect(defaultSlots(removePanel(DEFAULT_ARRANGEMENT, "artists"))).toBeNull();
    // Seven panels, but not the default seven.
    expect(defaultSlots(addPanel(removePanel(DEFAULT_ARRANGEMENT, "artists"), "repeat").arrangement)).toBeNull();
  });
});
