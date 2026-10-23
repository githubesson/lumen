import { describe, expect, it } from "vitest";
import type { TrackDetail, TrackInfoRow } from "@music-library/core";
import {
  focusedInTabs,
  trackInfoGridLines,
  trackInfoHref,
  trackInfoListItem,
} from "../lib/track-info";

describe("trackInfoHref", () => {
  it("opens each page in the current tab's stack", () => {
    const href = (kind: "artist" | "album", source: "local" | "tidal") =>
      trackInfoHref({ name: "X", kind, source, id: "7" });
    expect(href("artist", "local")).toEqual({ pathname: "/(tabs)/artists/[id]", params: { id: "7" } });
    expect(href("artist", "tidal")).toEqual({ pathname: "/(tabs)/tidal-artists/[id]", params: { id: "7" } });
    expect(href("album", "local")).toEqual({ pathname: "/(tabs)/albums/[id]", params: { id: "7" } });
    expect(href("album", "tidal")).toEqual({ pathname: "/(tabs)/tidal-albums/[id]", params: { id: "7" } });
  });
});

describe("trackInfoListItem", () => {
  it("gives the player and the menu what they read from a row", () => {
    const detail: TrackDetail = {
      id: "tidal:5",
      source: "tidal",
      source_id: "5",
      source_album_id: "9",
      title: "Song",
      album_id: "hidden",
      album_title: "Album",
      track_no: 2,
      duration_ms: 1000,
      format: "",
      file_size: 0,
      artists: [
        { id: "a", name: "Main", role: "primary" },
        { id: "b", name: "Guest", role: "featured" },
        { id: "c", name: "Writer", role: "composer" },
      ],
      has_cover: true,
      cover_url: "https://example.test/c.jpg",
      favorited: true,
    };
    expect(trackInfoListItem(detail)).toEqual({
      id: "tidal:5",
      db_track_id: undefined,
      source: "tidal",
      source_id: "5",
      source_album_id: "9",
      title: "Song",
      album_id: "hidden",
      album_title: "Album",
      track_no: 2,
      duration_ms: 1000,
      artist: "Main, Guest",
      favorited: true,
      has_cover: true,
      cover_url: "https://example.test/c.jpg",
    });
  });
});

describe("trackInfoGridLines", () => {
  const row = (label: string, wide?: boolean): TrackInfoRow => ({ label, value: "v", ...(wide ? { wide } : {}) });

  it("pairs rows two to a line, a wide row taking a line of its own", () => {
    const [a, b, c, wide, d] = [row("A"), row("B"), row("C"), row("W", true), row("D")];
    expect(trackInfoGridLines([a, b, c, wide, d])).toEqual([
      { wide: false, cells: [a, b] },
      // C's neighbour is left empty rather than filled from after the wide row.
      { wide: false, cells: [c, null] },
      { wide: true, cells: [wide] },
      { wide: false, cells: [d, null] },
    ]);
    expect(trackInfoGridLines([wide, wide])).toEqual([
      { wide: true, cells: [wide] },
      { wide: true, cells: [wide] },
    ]);
    expect(trackInfoGridLines([])).toEqual([]);
  });
});

describe("focusedInTabs", () => {
  const tabs = (tab: string) => ({
    index: 0,
    routes: [{ name: "__root", state: { index: 1, routes: [{ name: "(auth)" }, { name: "(tabs)", state: { index: 0, routes: [{ name: tab }] } }] } }],
  });

  it("finds a tab in front", () => {
    expect(focusedInTabs(tabs("(favorites)"))).toBe(true);
  });

  it("finds none behind a screen over the tabs", () => {
    expect(
      focusedInTabs({
        index: 0,
        routes: [{ name: "__root", state: { index: 1, routes: [{ name: "(tabs)" }, { name: "now-playing" }] } }],
      }),
    ).toBe(false);
    expect(focusedInTabs(undefined)).toBe(false);
    expect(focusedInTabs({ index: 3, routes: [] })).toBe(false);
  });

  it("reads a partial state's focus the way the navigators do", () => {
    // A stack's is its top route; anything else's, its first.
    const partial = (type: string) => ({ type, routes: [{ name: "(tabs)" }, { name: "now-playing" }] });
    expect(focusedInTabs(partial("stack"))).toBe(false);
    expect(focusedInTabs(partial("tab"))).toBe(true);
  });
});
