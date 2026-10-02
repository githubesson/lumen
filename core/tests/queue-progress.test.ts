import { describe, expect, it } from "vitest";
import type { TrackListItem } from "../src/api";
import { queueProgress } from "../src/player/queue-progress";

const tracks = (n: number): TrackListItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), title: String(i), duration_ms: 1000 }));

describe("queueProgress", () => {
  it("counts a local queue from its own length", () => {
    expect(queueProgress({ queue: tracks(10), index: 3 })).toEqual({
      offset: 0,
      position: 4,
      total: 10,
      upcoming: 6,
    });
    expect(queueProgress({ queue: tracks(10), index: 9 }).upcoming).toBe(0);
  });

  it("counts a remote snapshot window against the whole queue", () => {
    // A 50-track window starting at 100 of 300, playing its 25th track.
    expect(queueProgress({ queue: tracks(50), index: 24 }, { offset: 100, total: 300 })).toEqual({
      offset: 100,
      position: 125,
      total: 300,
      upcoming: 175,
    });
  });

  it("handles an empty queue and an out-of-range index", () => {
    expect(queueProgress({ queue: [], index: 0 })).toEqual({
      offset: 0,
      position: 0,
      total: 0,
      upcoming: 0,
    });
    expect(queueProgress({ queue: tracks(3), index: 7 }).position).toBe(3);
  });

  it("never reports a total smaller than the window it was given", () => {
    expect(queueProgress({ queue: tracks(5), index: 4 }, { offset: 10, total: 3 })).toEqual({
      offset: 10,
      position: 15,
      total: 15,
      upcoming: 0,
    });
  });
});
