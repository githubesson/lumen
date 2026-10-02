import { describe, expect, it } from "vitest";
import type { TrackListItem } from "../src/api";
import {
  buildNowPlayingMetadata,
  shouldExposeNowPlayingSession,
} from "../src/player/now-playing";

describe("shouldExposeNowPlayingSession", () => {
  it("keeps the session while a track is loaded locally, paused or not", () => {
    expect(shouldExposeNowPlayingSession({ hasTrack: true, isCasting: false })).toBe(true);
  });

  it("drops it with nothing loaded or while controlling another device", () => {
    expect(shouldExposeNowPlayingSession({ hasTrack: false, isCasting: false })).toBe(false);
    expect(shouldExposeNowPlayingSession({ hasTrack: true, isCasting: true })).toBe(false);
  });
});

describe("buildNowPlayingMetadata", () => {
  const track: TrackListItem = {
    id: "t1",
    title: "Song",
    artist: "Artist",
    album_id: "al1",
    album_title: "Album",
    duration_ms: 1000,
  };

  it("is null with nothing loaded", () => {
    expect(buildNowPlayingMetadata(null)).toBeNull();
  });

  it("carries title, artist, album and a large cover", () => {
    const metadata = buildNowPlayingMetadata({ ...track, title: "Song" });
    expect(metadata).toMatchObject({ title: "Song", artist: "Artist", albumTitle: "Album" });
    expect(metadata?.artworkUrl).toContain("al1");
    expect(metadata?.artworkUrl).toContain("1024");
  });

  it("omits a missing artist or album instead of sending an empty string", () => {
    const metadata = buildNowPlayingMetadata({ ...track, artist: undefined, album_title: "" });
    expect(metadata).not.toHaveProperty("artist", "");
    expect(metadata?.artist).toBeUndefined();
    expect(metadata?.albumTitle).toBeUndefined();
  });

  it("cleans double-encoded text like the in-app player does", () => {
    expect(buildNowPlayingMetadata({ ...track, title: "A Â· B" })?.title).toBe("A · B");
  });
});
