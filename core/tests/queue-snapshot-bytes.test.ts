import { expect, it } from "vitest";
import { buildPlaybackQueueSnapshot, utf8ByteLength } from "../src/player/queue-sync";
import type { PlayerState } from "../src/player/player-core";

it("measures serialized UTF-8 including escaping and surrogate pairs", () => {
  for (const value of ["ascii", "音🎵é", '"\\\n\t', "\ud800", "\udfff"]) {
    const serialized = JSON.stringify({ value });
    expect(utf8ByteLength(serialized)).toBe(new Blob([serialized]).size);
  }
});

it("respects an exact snapshot budget and never sends an empty replacement for an oversized current entry", () => {
  const track = { id: "t", title: "Track", duration_ms: 1000 };
  const state: PlayerState = {
    current: track, queue: [track], index: 0, isPlaying: true,
    volume: 1, muted: false, shuffle: false, repeat: "off",
  };
  const original = buildPlaybackQueueSnapshot(state, "revision")!;
  const bytes = new Blob([JSON.stringify(original)]).size;
  expect(buildPlaybackQueueSnapshot(state, "revision", bytes)).toEqual(original);
  expect(buildPlaybackQueueSnapshot(state, "revision", bytes - 1)).toBeNull();
});
