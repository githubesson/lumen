import { describe, expect, it } from "vitest";
import { SMOOTH_MIX_SECONDS } from "@music-library/core";
import {
  CROSSFADE_DETENTS,
  fadeAccessibilityValue,
  fadeLengthLabel,
  fadeTickLabel,
  nearestDetent,
  overlapWidth,
  stepDetent,
  timelineGeometry,
} from "../lib/settings/crossfade-timeline";

const DETENTS = [0, 3, 6, 9, 12];
// The mock's timeline: 333 pt wide, the next song at 112, 14 pt a second.
const mock = timelineGeometry(333, 12);
const at = (seconds: number) => mock.start + seconds * mock.perSecond;

describe("crossfade timeline", () => {
  it("snaps to Off and the player's own fade lengths", () => {
    expect(CROSSFADE_DETENTS).toEqual([0, ...SMOOTH_MIX_SECONDS]);
  });

  it("lays out like the mock at its width", () => {
    expect(mock.start).toBeCloseTo(112, 0);
    expect(mock.perSecond).toBeCloseTo(14, 0);
    // The longest fade ends well inside the timeline, leaving room for the knob.
    expect(at(12)).toBeLessThan(333 - 24);
  });

  it("scales with the width", () => {
    const wide = timelineGeometry(666, 12);
    expect(wide.start).toBeCloseTo(mock.start * 2);
    expect(wide.perSecond).toBeCloseTo(mock.perSecond * 2);
  });

  it("snaps a finger to the nearest detent", () => {
    expect(nearestDetent(at(0), mock, DETENTS)).toBe(0);
    expect(nearestDetent(at(6), mock, DETENTS)).toBe(6);
    expect(nearestDetent(at(4.4), mock, DETENTS)).toBe(3);
    expect(nearestDetent(at(4.6), mock, DETENTS)).toBe(6);
    expect(nearestDetent(at(10.4), mock, DETENTS)).toBe(9);
  });

  it("gives a tie to the shorter fade", () => {
    expect(nearestDetent(at(4.5), mock, DETENTS)).toBe(3);
  });

  it("holds at the ends when the finger runs past them", () => {
    expect(nearestDetent(0, mock, DETENTS)).toBe(0);
    expect(nearestDetent(-50, mock, DETENTS)).toBe(0);
    expect(nearestDetent(333, mock, DETENTS)).toBe(12);
    expect(nearestDetent(1_000, mock, DETENTS)).toBe(12);
  });

  it("stays on the first detent before the timeline is measured", () => {
    expect(nearestDetent(100, timelineGeometry(0, 12), DETENTS)).toBe(0);
    expect(nearestDetent(100, mock, [])).toBe(0);
  });

  it("keeps the overlap on the timeline", () => {
    expect(overlapWidth(6, mock)).toBeCloseTo(6 * mock.perSecond);
    expect(overlapWidth(20, mock)).toBeCloseTo(12 * mock.perSecond);
    expect(overlapWidth(-3, mock)).toBe(0);
  });

  it("steps up and down a detent for VoiceOver", () => {
    expect(stepDetent(6, 1, DETENTS)).toBe(9);
    expect(stepDetent(6, -1, DETENTS)).toBe(3);
    expect(stepDetent(0, -1, DETENTS)).toBe(0);
    expect(stepDetent(12, 1, DETENTS)).toBe(12);
  });

  it("steps from a length between detents to its neighbours", () => {
    expect(stepDetent(5, 1, DETENTS)).toBe(6);
    expect(stepDetent(5, -1, DETENTS)).toBe(3);
    expect(stepDetent(15, -1, DETENTS)).toBe(12);
    expect(stepDetent(15, 1, DETENTS)).toBe(15);
  });

  it("labels the value, the ticks and the spoken value", () => {
    expect(fadeLengthLabel(0)).toBe("Off");
    expect(fadeLengthLabel(6)).toBe("6 s");
    expect(fadeTickLabel(0)).toBe("Off");
    expect(fadeTickLabel(12)).toBe("12s");
    expect(fadeAccessibilityValue(0)).toBe("Off");
    expect(fadeAccessibilityValue(1)).toBe("1 second");
    expect(fadeAccessibilityValue(9)).toBe("9 seconds");
  });
});
