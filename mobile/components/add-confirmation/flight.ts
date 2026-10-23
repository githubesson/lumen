import type { WindowRect } from "./store";

/** The confirmation HUD's fixed geometry, in points (from the mock). */
export const HUD = {
  width: 176,
  radius: 30,
  paddingTop: 22,
  paddingX: 12,
  paddingBottom: 18,
  /** The two covers' box: the playlist's top right, the track's bottom left. */
  pairWidth: 88,
  pairHeight: 76,
  pairGap: 10,
  playlistSize: 64,
  playlistRadius: 12,
  trackSize: 52,
  trackRadius: 10,
  checkSize: 24,
  /** The gap ring around the track cover and the check. */
  ring: 2.5,
  /** Height at the default text size, for centring. */
  height: 174,
  /** Rest a little above the middle of the window. */
  raise: 16,
} as const;

/** The flight peaks at this scale halfway, then shrinks into the slot. */
const PEAK_SCALE = 1.28;
/** Halfway, the cover is this far above the straight line. */
const ARC_LIFT = 34;

/** The HUD's top-left corner at rest, in window points. */
export function hudOrigin(window: { width: number; height: number }): {
  x: number;
  y: number;
} {
  return {
    x: Math.round((window.width - HUD.width) / 2),
    y: Math.round((window.height - HUD.height) / 2 - HUD.raise),
  };
}

/** Where the track's cover lands in the HUD at rest. Text size doesn't move it. */
export function trackSlot(origin: { x: number; y: number }): WindowRect {
  return {
    x: origin.x + (HUD.width - HUD.pairWidth) / 2,
    y: origin.y + HUD.paddingTop + HUD.pairHeight - HUD.trackSize,
    width: HUD.trackSize,
    height: HUD.trackSize,
  };
}

/**
 * The flying cover at `progress` (0 at the card, 1 in the slot): the offset
 * of its centre from where it started, and its scale. It travels a shallow
 * curve, lifted at the middle, and swells on the way.
 */
export function flightFrame(
  progress: number,
  from: WindowRect,
  to: WindowRect,
): { translateX: number; translateY: number; scale: number } {
  "worklet";
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  // A quadratic curve whose midpoint is 55% of the way, ARC_LIFT higher.
  const controlX = 0.6 * dx;
  const controlY = 0.6 * dy - 2 * ARC_LIFT;
  const p = Math.min(1, Math.max(0, progress));
  const q = 1 - p;
  const endScale = from.width > 0 ? to.width / from.width : 1;
  const scale =
    p < 0.5
      ? 1 + (PEAK_SCALE - 1) * (p / 0.5)
      : PEAK_SCALE + (endScale - PEAK_SCALE) * ((p - 0.5) / 0.5);
  return {
    translateX: 2 * q * p * controlX + p * p * dx,
    translateY: 2 * q * p * controlY + p * p * dy,
    scale,
  };
}
