import { describe, expect, it } from "vitest";
import type { TrackDetail, TrackInfoRow } from "@music-library/core";
import {
  trackInfoGridLines,
  trackInfoHref,
  trackInfoListItem,
  trackMenuTab,
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
      owned: false,
      unavailable: true,
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
      owned: false,
      unavailable: true,
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

describe("trackMenuTab", () => {
  // The root stack (under expo-router's root slot): the tabs, then whatever
  // covers them.
  type NavState = Parameters<typeof trackMenuTab>[0];
  const root = (tabIndex: number, covers: string[] = [], favorites?: NavState): NavState => ({
    index: 0,
    routes: [
      {
        name: "__root",
        state: {
          type: "stack",
          index: covers.length,
          routes: [
            {
              name: "(tabs)",
              state: {
                type: "tab",
                index: tabIndex,
                routes: [
                  { name: "(library)" },
                  { name: "(playlists)" },
                  { name: "(browse)" },
                  { name: "(favorites)", state: favorites },
                  { name: "(settings)" },
                ],
              },
            },
            ...covers.map((name) => ({ name })),
          ],
        },
      },
    ],
  });
  const favoritesStack: NavState = {
    type: "stack",
    index: 1,
    routes: [{ name: "index" }, { name: "track/[id]", params: { id: "t1" } }],
  };

  it("opens in the tab in front, nothing to close", () => {
    expect(trackMenuTab(root(3, [], favoritesStack))).toEqual({
      tab: "(favorites)",
      cover: 0,
      top: { name: "track/[id]", params: { id: "t1" } },
    });
    expect(trackMenuTab(root(0))).toEqual({ tab: "(library)", cover: 0, top: null });
  });

  it("opens under Now Playing in the tab beneath it, once it closes", () => {
    expect(trackMenuTab(root(3, ["now-playing"], favoritesStack))).toMatchObject({ tab: "(favorites)", cover: 1 });
    expect(trackMenuTab(root(4, ["now-playing", "playlist-picker"]))).toMatchObject({ tab: "(settings)", cover: 2 });
  });

  it("finds no tab before the tabs are mounted", () => {
    expect(trackMenuTab(undefined)).toBeNull();
    expect(trackMenuTab({ index: 0, routes: [{ name: "(auth)" }] })).toBeNull();
    expect(trackMenuTab({ routes: [{ name: "(tabs)" }] })).toBeNull();
  });

  it("reads a partial state's focus the way the navigators do", () => {
    // A stack's is its top route; a tab navigator's, its first.
    const partial = {
      type: "stack",
      routes: [{ name: "(tabs)", state: { type: "tab", routes: [{ name: "(library)" }, { name: "(browse)" }] } }, { name: "now-playing" }],
    };
    expect(trackMenuTab(partial)).toEqual({ tab: "(library)", cover: 1, top: null });
  });
});
