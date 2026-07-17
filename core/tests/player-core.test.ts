import { describe, expect, it } from "vitest";
import {
  clampVolume,
  fisherYatesWithAnchor,
  nextRepeatMode,
  shouldReportPlay,
} from "../src/player/player-core";

describe("fisherYatesWithAnchor", () => {
  const items = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

  it("pins the anchor at index 0 and keeps every item exactly once", () => {
    const result = fisherYatesWithAnchor(items, "c");
    expect(result[0]?.id).toBe("c");
    expect(result).toHaveLength(items.length);
    expect([...result.map((t) => t.id)].sort()).toEqual(
      items.map((t) => t.id).sort(),
    );
  });

  it("never mutates the input array", () => {
    const input = items.map((t) => ({ ...t }));
    const before = input.map((t) => t.id);
    fisherYatesWithAnchor(input, "b");
    expect(input.map((t) => t.id)).toEqual(before);
  });

  it("shuffles everything when the anchor is null or unknown", () => {
    for (const anchor of [null, "missing"]) {
      const result = fisherYatesWithAnchor(items, anchor);
      expect(result).toHaveLength(items.length);
      expect([...result.map((t) => t.id)].sort()).toEqual(
        items.map((t) => t.id).sort(),
      );
    }
  });

  it("handles a single-item queue", () => {
    expect(fisherYatesWithAnchor([{ id: "a" }], "a")).toEqual([{ id: "a" }]);
  });
});

describe("nextRepeatMode", () => {
  it("cycles off → all → one → off", () => {
    expect(nextRepeatMode("off")).toBe("all");
    expect(nextRepeatMode("all")).toBe("one");
    expect(nextRepeatMode("one")).toBe("off");
  });
});

describe("clampVolume", () => {
  it("clamps into [0, 1]", () => {
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(2)).toBe(1);
  });
});

describe("shouldReportPlay", () => {
  it("fires at 30s regardless of duration", () => {
    expect(shouldReportPlay(29.9, 600)).toBe(false);
    expect(shouldReportPlay(30, 600)).toBe(true);
  });

  it("fires at 50% for short tracks", () => {
    expect(shouldReportPlay(9, 20)).toBe(false);
    expect(shouldReportPlay(10, 20)).toBe(true);
  });

  it("never fires for unknown-duration streams before 30s", () => {
    expect(shouldReportPlay(0, 0)).toBe(false);
    expect(shouldReportPlay(29, 0)).toBe(false);
    expect(shouldReportPlay(31, 0)).toBe(true);
  });
});
