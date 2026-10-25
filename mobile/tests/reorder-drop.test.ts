import { describe, expect, it } from "vitest";
import {
  isIndexIn,
  playlistAfterDrop,
  rebaseDrop,
  rowKeyOrIndex,
} from "../lib/reorder-drop";

const BAD_INDICES = [-1, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

/** `keys` after moving `from` to `to` the way the list and the server do. */
function applyMove(keys: readonly string[], move: { from: number; to: number }): string[] {
  const out = [...keys];
  const [key] = out.splice(move.from, 1);
  out.splice(move.to, 0, key);
  return out;
}

describe("rebaseDrop", () => {
  const rows = ["a", "b", "c", "d", "e"];

  it("passes a drop through when the rows didn't change", () => {
    expect(rebaseDrop(rows, rows, 4, 1)).toEqual({ from: 4, to: 1 });
    expect(rebaseDrop(rows, rows, 0, 4)).toEqual({ from: 0, to: 4 });
    expect(rebaseDrop(rows, [...rows], 2, 0)).toEqual({ from: 2, to: 0 });
  });

  it("replays a drop onto a list that shrank under the drag (LUMEN-4)", () => {
    // Dragging the last row up to second place while a refetch drops "c".
    // The library's indices (4, 1) now run past the end of the 4-row list.
    const current = ["a", "b", "d", "e"];
    const move = rebaseDrop(rows, current, 4, 1);
    expect(move).toEqual({ from: 3, to: 1 });
    expect(applyMove(current, move!)).toEqual(["a", "e", "b", "d"]);
  });

  it("moves the dragged row, not whatever took its index", () => {
    // "a" vanished, so index 2 is now "d"; the drag was "c" to the bottom.
    const current = ["b", "c", "d", "e"];
    const move = rebaseDrop(rows, current, 2, 4);
    expect(applyMove(current, move!)).toEqual(["b", "d", "e", "c"]);
  });

  it("goes above the row it was dropped above when the one it was dropped under is gone", () => {
    // "b" to between "c" and "d", but "c" is gone by the drop.
    const current = ["a", "b", "d", "e"];
    const move = rebaseDrop(rows, current, 1, 2);
    expect(move).toBeNull(); // "b" already sits right above "d"
    const moved = rebaseDrop(rows, ["b", "a", "d", "e"], 1, 2);
    expect(applyMove(["b", "a", "d", "e"], moved!)).toEqual(["a", "b", "d", "e"]);
  });

  it("puts a drop at the top above the row that was first", () => {
    const current = ["x", "a", "b", "d", "e"];
    const move = rebaseDrop(rows, current, 3, 0);
    expect(applyMove(current, move!)).toEqual(["x", "d", "a", "b", "e"]);
  });

  it("drops the move when the dragged row is gone", () => {
    expect(rebaseDrop(rows, ["a", "b", "c", "d"], 4, 1)).toBeNull();
  });

  it("drops the move when both its new neighbours are gone", () => {
    expect(rebaseDrop(rows, ["c", "d", "e"], 4, 1)).toBeNull();
  });

  it("ignores indices outside the rows the drag began on", () => {
    for (const bad of BAD_INDICES) {
      expect(rebaseDrop(rows, rows, bad, 1)).toBeNull();
      expect(rebaseDrop(rows, rows, 1, bad)).toBeNull();
    }
    expect(rebaseDrop(rows, rows, 2, 2)).toBeNull();
    expect(rebaseDrop([], [], 0, 0)).toBeNull();
  });

  it("only ever reports in-range moves of the dragged row, however the list shrank", () => {
    // Every drop on five rows, against every list left after removing rows.
    for (let mask = 0; mask < 1 << rows.length; mask++) {
      const current = rows.filter((_, i) => !(mask & (1 << i)));
      for (let from = 0; from < rows.length; from++) {
        for (let to = 0; to < rows.length; to++) {
          const move = rebaseDrop(rows, current, from, to);
          if (!move) continue;
          expect(isIndexIn(current, move.from)).toBe(true);
          expect(isIndexIn(current, move.to)).toBe(true);
          expect(move.from).not.toBe(move.to);
          expect(current[move.from]).toBe(rows[from]);
        }
      }
    }
  });
});

describe("rowKeyOrIndex", () => {
  it("keys a row by its key, and a missing one by its index", () => {
    expect(rowKeyOrIndex({ key: "t1:2026" }, 0)).toBe("t1:2026");
    // What the library hands keyExtractor for a stale index past the end.
    expect(rowKeyOrIndex(undefined, 4)).toBe("4");
  });
});

describe("playlistAfterDrop", () => {
  const entries = [
    { position: 0, track_id: "a" },
    { position: 1, track_id: "b" },
    { position: 3, track_id: "c" },
  ];

  it("moves a row and keeps the server's slots", () => {
    expect(playlistAfterDrop(entries, 2, 0)).toEqual([
      { position: 0, track_id: "c" },
      { position: 1, track_id: "a" },
      { position: 3, track_id: "b" },
    ]);
  });

  it("ignores out-of-range indices instead of building a reorder with undefined ids", () => {
    for (const bad of [-1, 3, 0.5, Number.NaN]) {
      expect(playlistAfterDrop(entries, bad, 0)).toBeNull();
      expect(playlistAfterDrop(entries, 0, bad)).toBeNull();
    }
    expect(playlistAfterDrop(entries, 1, 1)).toBeNull();
    expect(playlistAfterDrop([], 0, 0)).toBeNull();
  });
});
