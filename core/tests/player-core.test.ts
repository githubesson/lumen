import { describe, expect, it } from "vitest";
import {
  canStartTrack,
  clampVolume,
  extrapolatePosition,
  fisherYatesWithAnchor,
  nextRepeatMode,
  repeatModeLabel,
  shouldReportPlay,
} from "../src/player/player-core";

describe("fisherYatesWithAnchor", () => {
  it("preserves repeated playlist entries when the playing track is the anchor", () => {
    const first = { id: "a", entry: 1 };
    const repeated = { id: "a", entry: 2 };
    const other = { id: "b", entry: 3 };
    const result = fisherYatesWithAnchor([first, repeated, other], "a");
    expect(result[0]).toBe(first);
    expect(result).toHaveLength(3);
    expect(result).toContain(repeated);
    expect(result).toContain(other);
  });

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

describe("repeatModeLabel", () => {
  it("names the current mode, then what pressing the button does next", () => {
    expect(repeatModeLabel("off")).toBe("Repeat off. Turn on repeat");
    expect(repeatModeLabel("all")).toBe("Repeat all. Turn on repeat one");
    expect(repeatModeLabel("one")).toBe("Repeat one. Turn repeat off");
  });
});

describe("extrapolatePosition", () => {
  it("advances by the elapsed time and stops at the end of the track", () => {
    expect(extrapolatePosition(10, 2.5, 180)).toBe(12.5);
    expect(extrapolatePosition(179, 5, 180)).toBe(180);
  });

  it("leaves an unknown duration uncapped and never runs backwards", () => {
    expect(extrapolatePosition(10, 5, 0)).toBe(15);
    expect(extrapolatePosition(10, 5, Number.NaN)).toBe(15);
    expect(extrapolatePosition(10, -3, 180)).toBe(10);
  });
});

describe("canStartTrack", () => {
  it("rejects unavailable tracks even without a platform gate", () => {
    expect(canStartTrack({ id: "a" })).toBe(true);
    expect(canStartTrack({ id: "a", unavailable: true })).toBe(false);
    expect(canStartTrack({ id: "a", unavailable: true }, () => true)).toBe(false);
  });

  it("applies the platform gate to available tracks", () => {
    expect(canStartTrack({ id: "a" }, (id) => id === "b")).toBe(false);
    expect(canStartTrack({ id: "b" }, (id) => id === "b")).toBe(true);
  });
});
