/**
 * Math for the phone dock's cover slot. On collapse the mini player's cover
 * flies from its spot in the pill into a sixth slot at the right end of the
 * compact tab pill, turning from a rounded square into a circle, and a ring
 * around it shows how far the track has played.
 *
 * Every function here is a worklet: the dock's animated styles and the ring's
 * frame clock call them on the UI thread. Frames are in the dock's space: x
 * from its left edge, y up from its bottom edge (the dock is bottom-anchored,
 * so that edge stays put while the tab pill shrinks).
 */

export const COVER_SLOT = {
  /** The sixth slot's width at full collapse (the five tabs tighten to 54). */
  slotWidth: 48,
  /** The cover in the expanded pill: the pill row's control size (CONTROL_SIZE in dock-mini-player). */
  coverSize: 36,
  /** The cover as a circle in the slot. */
  circleSize: 32,
  /** The ring's canvas, the radius of its centreline, and its two strokes. */
  ringSize: 44,
  ringRadius: 19,
  arcWidth: 2.2,
  trackWidth: 1,
} as const;

/** The dock sizes the flight depends on. `DOCK` (dock-context) has most. */
export interface CoverSlotMetrics {
  tabCount: number;
  tabItemWidthCompact: number;
  tabPillHPadding: number;
  tabBarHeight: number;
  tabBarHeightCompact: number;
  miniHeight: number;
  miniRowHPadding: number;
  gap: number;
  phoneMiniMargin: number;
  /** The pill cover's corner radius (the theme's small radius). */
  coverRadius: number;
}

/** A cover frame: centre (dock space), side length and corner radius. */
export interface CoverFrame {
  x: number;
  y: number;
  size: number;
  radius: number;
}

function clamp01(value: number): number {
  "worklet";
  return Math.min(1, Math.max(0, value));
}

function lerp(from: number, to: number, t: number): number {
  "worklet";
  return from + (to - from) * t;
}

/** The tab pill's width: the tab slots, the cover slot and the side padding. */
export function tabPillWidth(
  m: Pick<CoverSlotMetrics, "tabCount" | "tabPillHPadding">,
  tabSlot: number,
  coverSlot: number,
): number {
  "worklet";
  return tabSlot * m.tabCount + coverSlot + m.tabPillHPadding * 2;
}

/**
 * The cover slot's width: it opens 0 → 48 with the collapse, and only while a
 * track is current (`presence` 0..1, animated when that changes).
 */
export function coverSlotWidth(collapse: number, presence: number): number {
  "worklet";
  return COVER_SLOT.slotWidth * clamp01(collapse) * clamp01(presence);
}

/** The cover in the expanded mini pill, first in its row. */
export function pillCoverFrame(m: CoverSlotMetrics): CoverFrame {
  "worklet";
  const size = COVER_SLOT.coverSize;
  return {
    x: m.phoneMiniMargin + m.miniRowHPadding + size / 2,
    y: m.tabBarHeight + m.gap + m.miniHeight / 2,
    size,
    radius: m.coverRadius,
  };
}

/** The circle in the sixth slot of the compact tab pill, which is centred in the dock. */
export function slotCoverFrame(m: CoverSlotMetrics, dockWidth: number): CoverFrame {
  "worklet";
  const pillWidth = tabPillWidth(m, m.tabItemWidthCompact, COVER_SLOT.slotWidth);
  const size = COVER_SLOT.circleSize;
  return {
    x: dockWidth / 2 + pillWidth / 2 - m.tabPillHPadding - COVER_SLOT.slotWidth / 2,
    y: m.tabBarHeightCompact / 2,
    size,
    radius: size / 2,
  };
}

/** The cover `progress` of the way through the collapse (0 = pill, 1 = slot). */
export function coverFlightFrame(
  m: CoverSlotMetrics,
  dockWidth: number,
  progress: number,
): CoverFrame {
  "worklet";
  const from = pillCoverFrame(m);
  const to = slotCoverFrame(m, dockWidth);
  const t = clamp01(progress);
  return {
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    size: lerp(from.size, to.size, t),
    radius: lerp(from.radius, to.radius, t),
  };
}

/** What the player last reported. Written from JS on each clock tick (4 Hz). */
export interface RingAnchor {
  /** Bumped on every write, so the frame clock can tell a new report from one it has seen. */
  seq: number;
  track: string | null;
  position: number;
  duration: number;
  playing: boolean;
}

/** The ring's clock, advanced on the UI thread. */
export interface RingClock {
  /** The anchor this clock is counting from. */
  seq: number;
  track: string | null;
  /** Seconds since that anchor arrived, counted in frames. */
  age: number;
  /** The position the ring shows, in seconds. */
  shown: number;
}

export const RING_CLOCK_START: RingClock = { seq: -1, track: null, age: 0, shown: 0 };

/**
 * Backward corrections smaller than this are rounding from the player's
 * 250 ms clock grid, not seeks: the ring holds still until the playhead
 * catches up instead of stepping back.
 */
export const RING_JITTER_SEC = 0.5;

/**
 * Longest frame step the clock counts. Reports land every 250 ms, so a longer
 * gap (the first frame back from the background) waits for the next report
 * rather than guessing past it.
 */
export const RING_MAX_FRAME_SEC = 0.25;

/**
 * Advance the ring's clock by one frame (`dt` seconds): the playhead is
 * extrapolated from the last report while playing, never past the end, and
 * never steps back on rounding jitter. A new track, a seek back or a pause
 * shows the reported position as is.
 */
export function stepRingClock(clock: RingClock, anchor: RingAnchor, dt: number): RingClock {
  "worklet";
  const fresh = anchor.seq !== clock.seq;
  const step = Math.min(RING_MAX_FRAME_SEC, Math.max(0, dt));
  const age = fresh ? 0 : clock.age + (anchor.playing ? step : 0);
  const end = anchor.duration > 0 ? anchor.duration : Infinity;
  const estimate = anchor.playing
    ? Math.min(end, anchor.position + age)
    : anchor.position;
  const hold =
    anchor.playing &&
    anchor.track === clock.track &&
    estimate < clock.shown &&
    clock.shown - estimate < RING_JITTER_SEC;
  return {
    seq: anchor.seq,
    track: anchor.track,
    age,
    shown: hold ? clock.shown : estimate,
  };
}

/** How far round the ring is, 0..1; empty while the duration is unknown. */
export function ringFraction(position: number, duration: number): number {
  "worklet";
  return duration > 0 ? clamp01(position / duration) : 0;
}

/**
 * Smallest arc movement worth a redraw, in points along the ring. Through a
 * three-minute song the arc creeps under a point a second, so redrawing every
 * frame would mostly repaint the same pixels.
 */
export const RING_REDRAW_STEP_PT = 0.1;

/** Whether the arc moved far enough from `from` to `to` to redraw. Empty and full always do. */
export function ringNeedsRedraw(from: number, to: number): boolean {
  "worklet";
  if (to === from) return false;
  if (to <= 0 || to >= 1) return true;
  return (
    Math.abs(to - from) * 2 * Math.PI * COVER_SLOT.ringRadius >=
    RING_REDRAW_STEP_PT
  );
}
