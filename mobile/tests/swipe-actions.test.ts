import { describe, expect, it } from "vitest";
import {
  ACTION_PADDING,
  actionContentX,
  actionIconOnly,
  actionWidth,
  cometHead,
  cometOpacity,
  cometOutline,
  cometPerimeter,
  cometRingOpacity,
  cometRingStart,
  cometTrim,
  commitDistance,
  resistedOffset,
  swipeRelease,
  COMET_RING_MS,
} from "../lib/swipe-actions";

const ROW = 393;

describe("swipe release", () => {
  it("commits at 45% of the row", () => {
    expect(commitDistance(ROW)).toBeCloseTo(176.85);
    expect(swipeRelease(177, 0, ROW)).toBe("commit");
    expect(swipeRelease(-177, 0, ROW)).toBe("commit");
    expect(swipeRelease(176, 0, ROW)).toBe("open");
  });

  it("rests open between 64 pt and the commit line, else springs back", () => {
    expect(swipeRelease(64, 0, ROW)).toBe("open");
    expect(swipeRelease(-120, 200, ROW)).toBe("open");
    expect(swipeRelease(63, 0, ROW)).toBe("close");
    expect(swipeRelease(-20, -300, ROW)).toBe("close");
  });

  it("commits a fast flick past 96 pt, and closes on a flick back", () => {
    expect(swipeRelease(97, 901, ROW)).toBe("commit");
    expect(swipeRelease(-97, -901, ROW)).toBe("commit");
    expect(swipeRelease(95, 2000, ROW)).toBe("open");
    expect(swipeRelease(150, -901, ROW)).toBe("close");
    expect(swipeRelease(150, 899, ROW)).toBe("open");
  });

  it("gives only a little on a side with no action", () => {
    expect(resistedOffset(0)).toBe(0);
    expect(resistedOffset(300)).toBeLessThan(24);
    expect(resistedOffset(-300)).toBeGreaterThan(-24);
    expect(resistedOffset(20)).toBeGreaterThan(0);
  });
});

describe("action capsule", () => {
  // "Play Next": a 20 pt icon, a 6 pt gap and the label.
  const content = 96;

  it("grows with the row, 8 pt off the screen edge and the row", () => {
    expect(actionWidth(10)).toBe(0);
    expect(actionWidth(140)).toBe(124);
    expect(actionWidth(-140)).toBe(124);
  });

  it("drops the label when there's no room for it", () => {
    expect(actionIconOnly(100, content)).toBe(true);
    expect(actionIconOnly(124, content)).toBe(false);
  });

  it("keeps its content by the screen edge until armed, then by the row", () => {
    const width = 220;
    expect(actionContentX("lead", width, content, 0)).toBe(ACTION_PADDING);
    expect(actionContentX("lead", width, content, 1)).toBe(width - content - ACTION_PADDING);
    expect(actionContentX("trail", width, content, 0)).toBe(width - content - ACTION_PADDING);
    expect(actionContentX("trail", width, content, 1)).toBe(ACTION_PADDING);
    expect(actionContentX("trail", width, content, 1, 1)).toBe((width - content) / 2);
  });

  it("centres the icon in a capsule too narrow for its padding", () => {
    expect(actionContentX("lead", 30, content, 0)).toBe(5);
  });
});

describe("comet", () => {
  const box = { x: 4, y: 4, width: 385, height: 48, radius: 14 };
  const perimeter = cometPerimeter(box);

  it("measures the rounded outline", () => {
    expect(perimeter).toBeCloseTo(2 * 357 + 2 * 20 + 2 * Math.PI * 14);
  });

  it("starts from the middle of the action's side", () => {
    expect(cometOutline(box, "left").startsWith("M 4 28 V 18")).toBe(true);
    expect(cometOutline(box, "right").startsWith("M 389 28 V 38")).toBe(true);
    expect(cometOutline(box, "right").endsWith("Z")).toBe(true);
  });

  it("runs the head past the start so the tail follows it home", () => {
    expect(cometHead(0, perimeter, 240)).toBe(0);
    expect(cometHead(1, perimeter, 240)).toBeCloseTo(perimeter + 204);
    expect(cometHead(0.5, perimeter, 240)).toBeCloseTo((perimeter + 204) / 2);
  });

  it("trims each layer to its length behind the head", () => {
    expect(cometTrim(0, 60, perimeter)).toEqual([0, 0]);
    const [start, end] = cometTrim(300, 60, perimeter);
    expect(start).toBeCloseTo(240 / perimeter);
    expect(end).toBeCloseTo(300 / perimeter);
    expect(cometTrim(perimeter + 100, 60, perimeter)).toEqual([1, 1]);
  });

  it("fades in quickly and out over the last 18%", () => {
    expect(cometOpacity(0)).toBe(0);
    expect(cometOpacity(0.06)).toBe(1);
    expect(cometOpacity(0.5)).toBe(1);
    expect(cometOpacity(0.91)).toBeCloseTo(0.5);
    expect(cometOpacity(1)).toBe(0);
  });

  it("breathes once as the head closes the loop", () => {
    const start = cometRingStart(perimeter, 240);
    expect(cometHead(start, perimeter, 240)).toBeCloseTo(perimeter * 0.97);
    expect(cometRingOpacity(-1)).toBe(0);
    expect(cometRingOpacity(COMET_RING_MS)).toBe(0);
    const peak = Math.max(
      ...Array.from({ length: 52 }, (_, i) => cometRingOpacity(i * 10)),
    );
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThanOrEqual(0.5);
  });
});
