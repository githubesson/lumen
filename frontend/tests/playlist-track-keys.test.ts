import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PlaylistTrackEntry } from "../src/api";
import { compareSortableTracks } from "@music-library/core/track-sort";
import { usePlaylistTrackKeys, compareEntries, type SortKey } from "../src/pages/playlist/trackSort";

afterEach(cleanup);

const tracks: PlaylistTrackEntry[] = [
  { position: 0, track_id: "a", title: "🔥 Song 10", duration_ms: 1000, play_count: 2, artist: "Artist", added_at: "" },
  { position: 1, track_id: "b", title: "Song 2", duration_ms: 1000, play_count: 2, album_title: "ALBUM", added_at: "" },
  { position: 2, track_id: "c", title: "  Écho   3  ", duration_ms: 2000, added_at: "" },
  { position: 3, track_id: "a", title: "🔥 Song 10", duration_ms: 1000, play_count: 2, added_at: "" },
  { position: 4, track_id: "d", title: "🔥", duration_ms: 0, play_count: 0, added_at: "" },
];

it.each<SortKey>(["custom", "title", "duration", "plays"])(
  "preserves %s ordering, including ties and duplicate tracks, with precomputed keys",
  (sortKey) => {
    const { result } = renderHook(() => usePlaylistTrackKeys(tracks, sortKey, ""));
    const expected = [...tracks].sort((a, b) => compareEntries(a, b, sortKey));
    const titleKeys = result.current.titleKeys ?? new Map<PlaylistTrackEntry, string>();
    const actual = [...tracks].sort((a, b) =>
      compareSortableTracks(a, b, sortKey, (track) => titleKeys.get(track)!),
    );
    expect(actual).toEqual(expected);
    expect(actual.map((track) => tracks.indexOf(track))).toEqual(expected.map((track) => tracks.indexOf(track)));
    expect([...actual].reverse()).toEqual([...expected].reverse());
    expect(tracks.map((track) => track.position)).toEqual([0, 1, 2, 3, 4]);
  },
);

it("keeps searchable emoji and matches title, artist and album without case sensitivity", () => {
  const { result } = renderHook(() => usePlaylistTrackKeys(tracks, "title", "album"));
  expect(result.current.titleKeys!.get(tracks[0])).toBe("Song 10");
  expect(result.current.searchKeys!.get(tracks[0])!.includes("🔥 song 10 artist")).toBe(true);
  expect(result.current.searchKeys!.get(tracks[1])!.includes("album")).toBe(true);
  expect(result.current.searchKeys!.get(tracks[2])!.includes("undefined")).toBe(false);
  expect(result.current.titleKeys!.get(tracks[4])).toBe("🔥");
});

it("rebuilds keys from updated metadata while keeping each playlist entry distinct", () => {
  const updated = { ...tracks[0], title: "Renamed", artist: "New artist" };
  const { result, rerender } = renderHook(
    ({ rows }) => usePlaylistTrackKeys(rows, "title", "song"),
    { initialProps: { rows: tracks } },
  );
  rerender({ rows: [updated, tracks[3]] });
  expect(result.current.titleKeys!.get(updated)).toBe("Renamed");
  expect(result.current.searchKeys!.get(updated)).toBe("renamed new artist ");
  expect(result.current.titleKeys!.get(tracks[3])).toBe("Song 10");
});

it("does no key-building work in the default view, including a polling refresh", () => {
  const titleRead = vi.fn(() => "Song");
  const makeTrack = () => ({ ...tracks[0], get title() { return titleRead(); } });
  const { result, rerender } = renderHook(
    ({ rows }) => usePlaylistTrackKeys(rows, "custom", ""),
    { initialProps: { rows: [makeTrack()] } },
  );
  rerender({ rows: [makeTrack()] });
  expect(result.current).toEqual({ titleKeys: null, searchKeys: null });
  expect(titleRead).not.toHaveBeenCalled();
});

it("builds only needed keys and reuses them across query and sort changes", () => {
  const { result, rerender } = renderHook(
    ({ sort, query }: { sort: SortKey; query: string }) => usePlaylistTrackKeys(tracks, sort, query),
    { initialProps: { sort: "custom" as SortKey, query: "s" } },
  );
  expect(result.current.titleKeys).toBeNull();
  const searchKeys = result.current.searchKeys;
  expect(searchKeys).not.toBeNull();
  rerender({ sort: "title", query: "song" });
  expect(result.current.searchKeys).toBe(searchKeys);
  const titleKeys = result.current.titleKeys;
  expect(titleKeys).not.toBeNull();
  rerender({ sort: "duration", query: "" });
  expect(result.current.titleKeys).toBe(titleKeys);
  expect(result.current.searchKeys).toBeNull();
});
