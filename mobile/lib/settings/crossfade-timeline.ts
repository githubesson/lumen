import { SMOOTH_MIX_SECONDS } from "@music-library/core";

/**
 * Layout and snapping for the Smooth mix timeline in Settings: the current
 * song's bar runs on past the point where the next song starts, and the
 * overlap is the crossfade. The next song's start is fixed; dragging moves
 * the end of the fade, which snaps to the fade lengths the player offers.
 *
 * The functions run on the UI thread inside the gesture, hence `"worklet"`.
 */

/** The fade lengths the timeline snaps to, in seconds; 0 is off. */
export const CROSSFADE_DETENTS: readonly number[] = [0, ...SMOOTH_MIX_SECONDS];

/** Where the next song starts, as a share of the timeline's width. */
const NEXT_START = 0.336;
/** How far past that the longest fade reaches, as a share of the width. */
const LONGEST_FADE = 0.504;

export interface TimelineGeometry {
  /** x of the next song's start: the fade's fixed edge. */
  start: number;
  /** Points per second of fade. */
  perSecond: number;
  /** The longest fade on the timeline, in seconds. */
  maxSeconds: number;
}

export function timelineGeometry(width: number, maxSeconds: number): TimelineGeometry {
  "worklet";
  const longest = maxSeconds > 0 ? maxSeconds : 1;
  const span = Math.max(0, width);
  return {
    start: span * NEXT_START,
    perSecond: (span * LONGEST_FADE) / longest,
    maxSeconds: longest,
  };
}

/** The overlap's width in points for a fade of `seconds`, kept on the timeline. */
export function overlapWidth(seconds: number, geometry: TimelineGeometry): number {
  "worklet";
  return Math.min(Math.max(seconds, 0), geometry.maxSeconds) * geometry.perSecond;
}

/** The detent nearest to a finger at `x`; a tie goes to the shorter fade. */
export function nearestDetent(
  x: number,
  geometry: TimelineGeometry,
  detents: readonly number[],
): number {
  "worklet";
  if (detents.length === 0) return 0;
  if (!(geometry.perSecond > 0)) return detents[0];
  const seconds = (x - geometry.start) / geometry.perSecond;
  let best = detents[0];
  let bestDistance = Math.abs(seconds - best);
  for (let i = 1; i < detents.length; i++) {
    const distance = Math.abs(seconds - detents[i]);
    if (distance < bestDistance) {
      best = detents[i];
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The next detent up or down from `seconds`, for VoiceOver's increment and
 * decrement. A length between detents (saved by an older build) steps to the
 * neighbouring one; at either end it stays put.
 */
export function stepDetent(
  seconds: number,
  direction: 1 | -1,
  detents: readonly number[],
): number {
  if (direction > 0) return detents.find((detent) => detent > seconds) ?? seconds;
  for (let i = detents.length - 1; i >= 0; i--) {
    if (detents[i] < seconds) return detents[i];
  }
  return seconds;
}

/** The value beside the tile's title: "Off" or "6 s". */
export function fadeLengthLabel(seconds: number): string {
  return seconds > 0 ? `${seconds} s` : "Off";
}

/** A tick under the timeline: "Off" or "6s". */
export function fadeTickLabel(seconds: number): string {
  return seconds > 0 ? `${seconds}s` : "Off";
}

/** What VoiceOver reads as the slider's value. */
export function fadeAccessibilityValue(seconds: number): string {
  if (seconds <= 0) return "Off";
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}
