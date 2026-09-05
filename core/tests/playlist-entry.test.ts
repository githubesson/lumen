import { describe, expect, it } from "vitest";
import { toQueueItem, type PlaylistTrackEntry } from "../src/api";
import { playlistEntryToTrack } from "../src/track";

describe("playlist entries across client queues", () => {
  const entry: PlaylistTrackEntry = {
    position: 7,
    track_id: "track",
    title: "Song",
    duration_ms: 123000,
    album_id: "album",
    has_cover: true,
    cover_url: "/cover",
    source: "tidal",
    source_id: "42",
    source_album_id: "43",
    added_at: "2026-09-05",
  };
  for (const [name, convert] of Object.entries({
    toQueueItem,
    playlistEntryToTrack,
  })) {
    it(`${name} preserves artwork and streaming identifiers but drops playlist ordering`, () => {
      const track = convert(entry);
      expect(track).toMatchObject({
        id: "track",
        album_id: "album",
        has_cover: true,
        cover_url: "/cover",
        source: "tidal",
        source_id: "42",
        source_album_id: "43",
      });
      expect(track).not.toHaveProperty("position");
      expect(entry.position).toBe(7);
    });
  }
});
