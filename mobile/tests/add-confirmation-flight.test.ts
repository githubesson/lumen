import { describe, expect, it } from "vitest";
import {
  HUD,
  flightFrame,
  hudOrigin,
  trackSlot,
} from "../components/add-confirmation/flight";

describe("confirmation HUD geometry", () => {
  it("rests centred, a little above the middle", () => {
    expect(hudOrigin({ width: 393, height: 852 })).toEqual({ x: 109, y: 323 });
  });

  it("lands the track's cover at the pair's bottom left", () => {
    expect(trackSlot({ x: 109, y: 323 })).toEqual({
      x: 109 + 44,
      y: 323 + HUD.paddingTop + HUD.pairHeight - HUD.trackSize,
      width: 52,
      height: 52,
    });
  });
});

describe("flightFrame", () => {
  const from = { x: 32, y: 440, width: 48, height: 48 };
  const to = { x: 153, y: 369, width: 52, height: 52 };
  const dx = to.x + 26 - (from.x + 24);
  const dy = to.y + 26 - (from.y + 24);

  it("starts on the card", () => {
    const start = flightFrame(0, from, to);
    expect(start.translateX).toBeCloseTo(0);
    expect(start.translateY).toBeCloseTo(0);
    expect(start.scale).toBe(1);
  });

  it("ends centred on the slot at the slot's size", () => {
    const end = flightFrame(1, from, to);
    expect(end.translateX).toBeCloseTo(dx);
    expect(end.translateY).toBeCloseTo(dy);
    expect(end.scale).toBeCloseTo(52 / 48);
  });

  it("swells and lifts above the straight line halfway", () => {
    const mid = flightFrame(0.5, from, to);
    expect(mid.translateX).toBeCloseTo(0.55 * dx);
    expect(mid.translateY).toBeCloseTo(0.55 * dy - 34);
    expect(mid.scale).toBeCloseTo(1.28);
  });

  it("holds the ends outside 0…1", () => {
    expect(flightFrame(-1, from, to)).toEqual(flightFrame(0, from, to));
    expect(flightFrame(2, from, to)).toEqual(flightFrame(1, from, to));
  });
});
