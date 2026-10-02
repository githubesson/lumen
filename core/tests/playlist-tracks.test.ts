import { describe, expect, it } from "vitest";
import {
  PLAYLIST_AUTO_DOWNLOAD_REFRESH_MS,
  movePlaylistEntry,
  queuedTidalCount,
  removePlaylistEntry,
} from "../src/playlist-tracks";
import {
  compareSortableTracks,
  sortForDisplay,
  sortTitleKey,
} from "../src/track-sort";

const rows = (positions: number[]) =>
  positions.map((position) => ({ position, id: `p${position}` }));

describe("removePlaylistEntry", () => {
  it("moves every later row up one, like the server", () => {
    expect(removePlaylistEntry(rows([0, 1, 2, 3]), 1)).toEqual([
      { position: 0, id: "p0" },
      { position: 1, id: "p2" },
      { position: 2, id: "p3" },
    ]);
  });

  it("keeps the gaps left by rows the server didn't send", () => {
    // Position 1 is another user's personal upload: the server shifts it
    // too, so the visible rows after the removed one keep their gap.
    const next = removePlaylistEntry(rows([0, 2, 3]), 0);
    expect(next.map((r) => [r.id, r.position])).toEqual([
      ["p2", 1],
      ["p3", 2],
    ]);
    // A second remove addressed by the optimistic rows targets the same row
    // the server now holds at that position.
    expect(removePlaylistEntry(next, 1).map((r) => [r.id, r.position])).toEqual([["p3", 1]]);
  });

  it("keeps the identity of rows whose position didn't change", () => {
    const before = rows([0, 1, 2]);
    const after = removePlaylistEntry(before, 2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it("changes nothing when no row has that position", () => {
    const before = rows([0, 2]);
    const after = removePlaylistEntry(before, 1);
    expect(after).toEqual(before);
    expect(after).not.toBe(before);
  });
});

describe("movePlaylistEntry", () => {
  it("reorders and renumbers rows into the same slots", () => {
    expect(movePlaylistEntry(rows([0, 1, 2]), 0, 2)).toEqual([
      { position: 0, id: "p1" },
      { position: 1, id: "p2" },
      { position: 2, id: "p0" },
    ]);
  });

  it("leaves hidden rows' slots alone", () => {
    // Slot 1 holds a row this viewer can't see; the server keeps it there.
    const next = movePlaylistEntry(rows([0, 2, 5]), 2, 0);
    expect(next.map((r) => [r.id, r.position])).toEqual([
      ["p5", 0],
      ["p0", 2],
      ["p2", 5],
    ]);
  });

  it("ignores a no-op or out-of-range move", () => {
    const before = rows([0, 1]);
    expect(movePlaylistEntry(before, 1, 1)).toEqual(before);
    expect(movePlaylistEntry(before, -1, 0)).toEqual(before);
    expect(movePlaylistEntry(before, 0, 2)).toEqual(before);
  });
});

describe("queuedTidalCount", () => {
  it("counts the rows still on TIDAL", () => {
    expect(queuedTidalCount([{ source: "tidal" }, { source: "local" }, {}, { source: "tidal" }])).toBe(2);
    expect(queuedTidalCount([])).toBe(0);
  });

  it("refreshes every 20 seconds while tracks are queued", () => {
    expect(PLAYLIST_AUTO_DOWNLOAD_REFRESH_MS).toBe(20_000);
  });
});

describe("sortForDisplay", () => {
  const tracks = [
    { title: "b", duration_ms: 2, play_count: 1 },
    { title: "a", duration_ms: 2, play_count: 1 },
    { title: "c", duration_ms: 1, play_count: 3 },
  ];

  it("returns the saved order itself for custom", () => {
    expect(sortForDisplay(tracks, "custom", false, () => 1)).toBe(tracks);
  });

  it("sorts a copy, reversed when descending", () => {
    const byDuration = (a: (typeof tracks)[number], b: (typeof tracks)[number]) =>
      compareSortableTracks(a, b, "duration");
    expect(sortForDisplay(tracks, "duration", true, byDuration).map((t) => t.title)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(sortForDisplay(tracks, "duration", false, byDuration).map((t) => t.title)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(tracks.map((t) => t.title)).toEqual(["b", "a", "c"]);
  });
});

describe("compareSortableTracks with precomputed title keys", () => {
  it("orders exactly as computing the keys on the fly", () => {
    const tracks = [
      { title: "🔥 Song 10", duration_ms: 1, play_count: 2 },
      { title: "Song 2", duration_ms: 1, play_count: 2 },
      { title: "  Écho   3  ", duration_ms: 2 },
      { title: "🔥", duration_ms: 0, play_count: 0 },
    ];
    const keys = new Map(tracks.map((t) => [t, sortTitleKey(t.title)]));
    for (const key of ["title", "duration", "plays", "custom"] as const) {
      const live = [...tracks].sort((a, b) => compareSortableTracks(a, b, key));
      const precomputed = [...tracks].sort((a, b) =>
        compareSortableTracks(a, b, key, (t) => keys.get(t)!),
      );
      expect(precomputed).toEqual(live);
    }
  });

  it("uses only the keys it's given", () => {
    const a = { title: "z", duration_ms: 0 };
    const b = { title: "a", duration_ms: 0 };
    const reversed = (t: { title: string }) => (t.title === "z" ? "a" : "z");
    expect(compareSortableTracks(a, b, "title", reversed)).toBeLessThan(0);
  });
});
