import { describe, expect, it } from "vitest";
import type { TrackListItem } from "../src/api";
import { playbackErrorLines, playbackErrorText } from "../src/player/playback-error";
import type { PlaybackError } from "../src/player/player-core";

const track: TrackListItem = {
  id: "tidal:1",
  title: "Thrills (v2.2)",
  artist: "Someone",
  duration_ms: 180_000,
};

const failure = (details: Partial<PlaybackError["details"]> = {}): PlaybackError => ({
  trackId: "tidal:1",
  message: "Couldn't play this track.",
  details: {
    at: Date.UTC(2026, 9, 29, 12, 0, 0),
    source: "/api/tracks/tidal%3A1/stream",
    player: "hls.js manifestLoadError: A network error (status 502) occurred while loading manifest",
    server: "HTTP 502 · TIDAL refused to stream this track",
    ...details,
  },
});

describe("playbackErrorLines", () => {
  it("lists what happened, in order", () => {
    expect(playbackErrorText(playbackErrorLines(failure(), track))).toBe(
      [
        "Error: Couldn't play this track.",
        "Track: Thrills (v2.2) — Someone",
        "Track ID: tidal:1",
        "Source: /api/tracks/tidal%3A1/stream",
        "Player: hls.js manifestLoadError: A network error (status 502) occurred while loading manifest",
        "Server: HTTP 502 · TIDAL refused to stream this track",
        "Time: 2026-10-29T12:00:00.000Z",
      ].join("\n"),
    );
  });

  it("says when nobody gave a reason, or the server wasn't asked", () => {
    const lines = playbackErrorLines(failure({ player: null, server: null }), track);
    expect(lines).toContainEqual({ label: "Player", value: "Gave no reason" });
    expect(lines).toContainEqual({ label: "Server", value: "Not asked: a downloaded copy" });
  });

  it("says the server is still being asked", () => {
    const lines = playbackErrorLines(failure({ server: undefined }), track);
    expect(lines).toContainEqual({ label: "Server", value: "Asking…" });
  });

  it("leaves the track out once another one is loaded", () => {
    const lines = playbackErrorLines(failure(), { ...track, id: "tidal:2" });
    expect(lines.map((line) => line.label)).not.toContain("Track");
  });
});
