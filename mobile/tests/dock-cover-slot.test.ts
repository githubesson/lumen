import { describe, expect, it } from "vitest";
import {
  COVER_SLOT,
  RING_CLOCK_START,
  RING_JITTER_SEC,
  RING_MAX_FRAME_SEC,
  coverFlightFrame,
  coverSlotWidth,
  pillCoverFrame,
  ringFraction,
  ringNeedsRedraw,
  slotCoverFrame,
  stepRingClock,
  tabPillWidth,
  type CoverSlotMetrics,
  type RingAnchor,
  type RingClock,
} from "../lib/dock-cover-slot";

// Today's DOCK sizes (components/dock/dock-context.tsx) and theme radius.
const METRICS: CoverSlotMetrics = {
  tabCount: 5,
  tabItemWidthCompact: 54,
  tabPillHPadding: 8,
  tabBarHeight: 64,
  tabBarHeightCompact: 52,
  miniHeight: 56,
  miniRowHPadding: 12,
  gap: 10,
  phoneMiniMargin: 20,
  coverRadius: 6,
};

// The mock's phone (mini-player/i.html) is 393 pt wide.
const WIDTH = 393;

describe("tab pill and cover slot widths", () => {
  it("keeps the expanded pill at today's width", () => {
    expect(tabPillWidth(METRICS, 64, coverSlotWidth(0, 1))).toBe(336);
  });

  it("gives the compact pill a sixth 48 pt slot (334 pt, the mock's width)", () => {
    expect(coverSlotWidth(1, 1)).toBe(COVER_SLOT.slotWidth);
    expect(tabPillWidth(METRICS, 54, coverSlotWidth(1, 1))).toBe(334);
  });

  it("keeps five slots when no track is current", () => {
    expect(coverSlotWidth(1, 0)).toBe(0);
    expect(tabPillWidth(METRICS, 54, coverSlotWidth(1, 0))).toBe(286);
  });

  it("opens the slot with the collapse and clamps overshoot", () => {
    expect(coverSlotWidth(0.5, 1)).toBe(24);
    expect(coverSlotWidth(1.04, 1)).toBe(48);
    expect(coverSlotWidth(-0.02, 1)).toBe(0);
  });
});

describe("the cover's flight", () => {
  it("starts on the pill's cover: 36 pt at 32 pt in, centred in the pill", () => {
    expect(pillCoverFrame(METRICS)).toEqual({ x: 50, y: 102, size: 36, radius: 6 });
  });

  it("lands as a 32 pt circle centred in the sixth slot", () => {
    // Mock: chip left 315.5, bottom 26 over a dock 16 pt off the bottom.
    expect(slotCoverFrame(METRICS, WIDTH)).toEqual({ x: 331.5, y: 26, size: 32, radius: 16 });
  });

  it("follows the dock width, since the tab pill is centred", () => {
    expect(slotCoverFrame(METRICS, 430).x).toBe(350);
    expect(slotCoverFrame(METRICS, 375).x).toBe(322.5);
  });

  it("moves, shrinks and rounds in step with the collapse", () => {
    expect(coverFlightFrame(METRICS, WIDTH, 0)).toEqual(pillCoverFrame(METRICS));
    expect(coverFlightFrame(METRICS, WIDTH, 1)).toEqual(slotCoverFrame(METRICS, WIDTH));
    expect(coverFlightFrame(METRICS, WIDTH, 0.5)).toEqual({
      x: 190.75,
      y: 64,
      size: 34,
      radius: 11,
    });
  });

  it("never overshoots either end", () => {
    expect(coverFlightFrame(METRICS, WIDTH, 1.03)).toEqual(slotCoverFrame(METRICS, WIDTH));
    expect(coverFlightFrame(METRICS, WIDTH, -0.1)).toEqual(pillCoverFrame(METRICS));
  });
});

function anchor(partial: Partial<RingAnchor> = {}): RingAnchor {
  return { seq: 1, track: "a", position: 10, duration: 100, playing: true, ...partial };
}

/** Runs `frames` frames of `dt` seconds through the clock. */
function run(clock: RingClock, a: RingAnchor, frames: number, dt = 1 / 60): RingClock {
  let next = clock;
  for (let i = 0; i < frames; i += 1) next = stepRingClock(next, a, dt);
  return next;
}

describe("the ring's clock", () => {
  it("starts from a new report and extrapolates while playing", () => {
    const first = stepRingClock(RING_CLOCK_START, anchor(), 1 / 60);
    expect(first).toEqual({ seq: 1, track: "a", age: 0, shown: 10 });
    const later = run(first, anchor(), 30);
    expect(later.shown).toBeCloseTo(10.5, 6);
  });

  it("re-bases on each report, so a later report carries on smoothly", () => {
    const clock = run(stepRingClock(RING_CLOCK_START, anchor(), 0), anchor(), 15);
    expect(clock.shown).toBeCloseTo(10.25, 6);
    const rebased = stepRingClock(clock, anchor({ seq: 2, position: 10.25 }), 1 / 60);
    expect(rebased.age).toBe(0);
    expect(rebased.shown).toBeCloseTo(10.25, 6);
  });

  it("holds still on a small step back from the clock's rounding", () => {
    const clock = run(stepRingClock(RING_CLOCK_START, anchor(), 0), anchor(), 24);
    expect(clock.shown).toBeCloseTo(10.4, 6);
    const rounded = stepRingClock(clock, anchor({ seq: 2, position: 10.25 }), 1 / 60);
    expect(rounded.shown).toBe(clock.shown);
    // ...and moves again once the playhead passes where it held.
    const caughtUp = run(rounded, anchor({ seq: 2, position: 10.25 }), 12);
    expect(caughtUp.shown).toBeGreaterThan(clock.shown);
  });

  it("jumps back on a seek", () => {
    const clock = stepRingClock(RING_CLOCK_START, anchor({ position: 60 }), 0);
    const seeked = stepRingClock(clock, anchor({ seq: 2, position: 60 - RING_JITTER_SEC - 1 }), 0);
    expect(seeked.shown).toBe(58.5);
  });

  it("restarts from the top on a new track, even a step back", () => {
    const clock = stepRingClock(RING_CLOCK_START, anchor({ position: 0.3 }), 0);
    const next = stepRingClock(clock, anchor({ seq: 2, track: "b", position: 0 }), 0);
    expect(next.shown).toBe(0);
  });

  it("holds the reported position while paused", () => {
    const paused = anchor({ playing: false, position: 42 });
    const clock = run(stepRingClock(RING_CLOCK_START, paused, 0), paused, 120);
    expect(clock.shown).toBe(42);
    expect(clock.age).toBe(0);
  });

  it("never runs past the end of the track", () => {
    const clock = run(stepRingClock(RING_CLOCK_START, anchor({ position: 99.9 }), 0), anchor({ position: 99.9 }), 60);
    expect(clock.shown).toBe(100);
  });

  it("keeps counting before the duration is known", () => {
    const unknown = anchor({ duration: 0, position: 1 });
    const clock = run(stepRingClock(RING_CLOCK_START, unknown, 0), unknown, 60);
    expect(clock.shown).toBeCloseTo(2, 6);
  });

  it("ignores a negative frame step", () => {
    const clock = stepRingClock(RING_CLOCK_START, anchor(), 0);
    expect(stepRingClock(clock, anchor(), -1).shown).toBe(10);
  });

  it("caps a long frame gap at one report's worth", () => {
    const clock = stepRingClock(RING_CLOCK_START, anchor(), 0);
    expect(stepRingClock(clock, anchor(), 30).shown).toBe(10 + RING_MAX_FRAME_SEC);
  });
});

describe("ring fraction", () => {
  it("is the share of the track played, clamped to the ring", () => {
    expect(ringFraction(45, 180)).toBe(0.25);
    expect(ringFraction(200, 180)).toBe(1);
    expect(ringFraction(-1, 180)).toBe(0);
  });

  it("is empty while the duration is unknown", () => {
    expect(ringFraction(12, 0)).toBe(0);
    expect(ringFraction(12, Number.NaN)).toBe(0);
  });
});

describe("ring redraws", () => {
  const circumference = 2 * Math.PI * COVER_SLOT.ringRadius;

  it("skips moves smaller than a tenth of a point along the ring", () => {
    expect(ringNeedsRedraw(0.5, 0.5)).toBe(false);
    expect(ringNeedsRedraw(0.5, 0.5 + 0.05 / circumference)).toBe(false);
    expect(ringNeedsRedraw(0.5, 0.5 + 0.12 / circumference)).toBe(true);
  });

  it("always draws a restart and a full ring", () => {
    expect(ringNeedsRedraw(0.0001, 0)).toBe(true);
    expect(ringNeedsRedraw(0.9999, 1)).toBe(true);
  });
});
