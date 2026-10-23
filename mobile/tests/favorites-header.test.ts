import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEADER_GEOMETRY,
  FAVORITES_HEADER,
  collapsedOffset,
  controlsDocked,
  controlsOpacity,
  listSummary,
  smoothstep,
  switchPlacement,
  switchScrollTarget,
  titleClip,
  type HeaderGeometry,
} from "../lib/favorites-header";

const minutes = (m: number) => ({ duration_ms: m * 60_000 });

describe("listSummary", () => {
  it("counts favorites with their running time", () => {
    expect(listSummary("favorites", [minutes(20), minutes(33.5)])).toBe(
      "2 songs, 53 min",
    );
    expect(listSummary("favorites", [minutes(3)])).toBe("1 song, 3 min");
    expect(listSummary("favorites", [minutes(70), minutes(55)])).toBe(
      "2 songs, 2 hr 5 min",
    );
  });

  it("gives recent plays no total, only their order", () => {
    expect(listSummary("recent", [minutes(3), minutes(4)])).toBe(
      "2 songs, last played first",
    );
    expect(listSummary("recent", [minutes(3)])).toBe("1 song, last played first");
  });

  it("ignores unknown durations and says nothing for an empty list", () => {
    expect(
      listSummary("favorites", [minutes(10), { duration_ms: Number.NaN }, { duration_ms: -5 }]),
    ).toBe("3 songs, 10 min");
    expect(listSummary("favorites", [])).toBe("");
    expect(listSummary("recent", [])).toBe("");
  });
});

describe("smoothstep", () => {
  it("eases from 0 to 1 and clamps outside", () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(2)).toBe(1);
    expect(smoothstep(0.25)).toBeLessThan(0.25);
  });
});

describe("switchPlacement", () => {
  const barTop = 59;
  const width = 393;
  const g = DEFAULT_HEADER_GEOMETRY;
  const expandedWidth = FAVORITES_HEADER.switchWidth * FAVORITES_HEADER.expandedScale;

  it("trails the large title, a size up, at rest", () => {
    const p = switchPlacement(0, g, barTop, width);
    expect(p.x).toBeCloseTo(width - 16 - expandedWidth);
    // centred in the title row, which starts at the bar's bottom edge
    expect(p.y).toBeCloseTo(barTop + 44 + (53 - 44 * 1.2) / 2);
    expect(p.scale).toBe(1.2);
  });

  it("docks in the bar's leading slot at its own size once scrolled", () => {
    for (const s of [64, 200, 5000]) {
      expect(switchPlacement(s, g, barTop, width)).toEqual({ x: 16, y: barTop, scale: 1 });
    }
  });

  it("rises with the content, then holds at the bar while it finishes shrinking", () => {
    const rest = switchPlacement(0, g, barTop, width);
    const mid = switchPlacement(20, g, barTop, width);
    expect(mid.y).toBeCloseTo(rest.y - 20);
    expect(mid.x).toBeLessThan(rest.x);
    expect(mid.x).toBeGreaterThan(16);
    expect(mid.scale).toBeLessThan(1.2);
    expect(mid.scale).toBeGreaterThan(1);
    const atBar = switchPlacement(50, g, barTop, width);
    expect(atBar.y).toBe(barTop);
    expect(atBar.scale).toBeGreaterThan(1);
  });

  it("follows a pull to refresh down without shrinking", () => {
    const pulled = switchPlacement(-80, g, barTop, width);
    expect(pulled.y).toBeCloseTo(switchPlacement(0, g, barTop, width).y + 80);
    expect(pulled.scale).toBe(1.2);
  });

  it("stays centred in a taller title row (larger text)", () => {
    const tall: HeaderGeometry = { ...g, titleRowHeight: 73 };
    expect(switchPlacement(0, tall, barTop, width).y).toBeCloseTo(
      barTop + 44 + (73 - 52.8) / 2,
    );
  });
});

describe("titleClip", () => {
  const g = DEFAULT_HEADER_GEOMETRY;

  it("cuts the title off at the bar's bottom edge as it scrolls under", () => {
    expect(titleClip(-30, g)).toBe(0);
    expect(titleClip(0, g)).toBe(0);
    expect(titleClip(20, g)).toBe(20);
    expect(titleClip(53, g)).toBe(53);
    expect(titleClip(400, g)).toBe(53);
  });
});

describe("header controls", () => {
  const g = DEFAULT_HEADER_GEOMETRY;
  // controls bottom 191: 147 below the bar's bottom edge at rest
  it("stay solid until they come near the bar, then fade out before reaching it", () => {
    expect(controlsOpacity(0, g)).toBe(1);
    expect(controlsOpacity(73, g)).toBe(1);
    expect(controlsOpacity(95, g)).toBeCloseTo(0.5);
    expect(controlsOpacity(117, g)).toBe(0);
    expect(controlsOpacity(140, g)).toBe(0);
    expect(controlsDocked(117, g)).toBe(false);
  });

  it("dock once their bottom passes under the bar", () => {
    expect(controlsDocked(147, g)).toBe(false);
    expect(controlsDocked(147.5, g)).toBe(true);
    expect(collapsedOffset(g)).toBe(148);
    expect(controlsDocked(collapsedOffset(g), g)).toBe(true);
  });
});

describe("switchScrollTarget", () => {
  const collapseAt = 148;

  it("leaves the other list where it was when switching from the expanded header", () => {
    expect(switchScrollTarget(0, 0, collapseAt)).toBeNull();
    expect(switchScrollTarget(100, 900, collapseAt)).toBeNull();
  });

  it("keeps the header collapsed when switching from the bar", () => {
    expect(switchScrollTarget(600, 0, collapseAt)).toBe(collapseAt);
    expect(switchScrollTarget(collapseAt, 40, collapseAt)).toBe(collapseAt);
  });

  it("keeps a list that was already scrolled deeper where it was", () => {
    expect(switchScrollTarget(600, 900, collapseAt)).toBeNull();
    expect(switchScrollTarget(600, collapseAt, collapseAt)).toBeNull();
  });
});
