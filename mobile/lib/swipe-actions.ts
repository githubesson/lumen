/**
 * Geometry and timing for the swipe actions on song rows (swipe right: Play
 * Next; swipe left: Favorite or Unfavorite) and the comet that confirms them.
 * Plain functions marked as worklets, so the gesture and the comet run them
 * on the UI thread and the tests run them in Node.
 */

/** Horizontal travel before the row's pan claims the touch from scrolling. */
export const SWIPE_ACTIVATE_DISTANCE = 12;
/** Touches that start this close to the left edge belong to the back swipe. */
export const SWIPE_EDGE_INSET = 24;
/** Released short of this, the row springs back. */
export const SWIPE_REVEAL_DISTANCE = 64;
/** Released between reveal and commit, the row rests open this far. */
export const SWIPE_OPEN_DISTANCE = 140;
/** Past this share of the row's width, a release commits. */
export const SWIPE_COMMIT_RATIO = 0.45;
/** A flick this fast (pt/s) commits once the row is out this far. */
export const SWIPE_FLICK_VELOCITY = 900;
export const SWIPE_FLICK_DISTANCE = 96;

/** The action capsule: inset from the screen edge, the row edge and the top. */
export const ACTION_INSET = 8;
export const ACTION_TOP = 6;
export const ACTION_HEIGHT = 44;
/** Space between the capsule's content and its ends. */
export const ACTION_PADDING = 16;
export const ACTION_ICON_SIZE = 20;

/** The row's offset at which a release commits (177 pt on a 393 pt row). */
export function commitDistance(rowWidth: number): number {
  "worklet";
  return (rowWidth > 0 ? rowWidth : 393) * SWIPE_COMMIT_RATIO;
}

export type SwipeRelease = "close" | "open" | "commit";

/**
 * What a release at offset `dx` (positive: swiped right) moving at `vx` does.
 * A flick toward closed closes even from far out.
 */
export function swipeRelease(dx: number, vx: number, rowWidth: number): SwipeRelease {
  "worklet";
  const distance = Math.abs(dx);
  if (distance >= commitDistance(rowWidth)) return "commit";
  const outward = dx !== 0 && Math.sign(vx) === Math.sign(dx);
  if (Math.abs(vx) > SWIPE_FLICK_VELOCITY) {
    if (outward && distance > SWIPE_FLICK_DISTANCE) return "commit";
    if (!outward) return "close";
  }
  return distance >= SWIPE_REVEAL_DISTANCE ? "open" : "close";
}

/**
 * How far a row with no action on that side follows the finger: a short,
 * stiffening give, so the swipe reads as "nothing there" instead of dead.
 */
export function resistedOffset(dx: number): number {
  "worklet";
  return Math.sign(dx) * 24 * (1 - Math.exp(-Math.abs(dx) / 60));
}

/** The action capsule's width at row offset `dx`. */
export function actionWidth(dx: number): number {
  "worklet";
  return Math.max(0, Math.abs(dx) - ACTION_INSET * 2);
}

/** Whether a capsule of `width` is too narrow for its label (icon only). */
export function actionIconOnly(width: number, contentWidth: number): boolean {
  "worklet";
  return width < contentWidth + 18;
}

/**
 * Where the capsule's content (icon, then label) starts inside a capsule of
 * `width`. At rest it sits by the screen edge; `armed` (0 to 1, past the
 * commit line) carries it to the row's edge, under the finger's pull.
 * `centered` (0 to 1) takes it to the middle, as the row leaves for good.
 */
export function actionContentX(
  side: "lead" | "trail",
  width: number,
  contentWidth: number,
  armed: number,
  centered = 0,
): number {
  "worklet";
  const shown = actionIconOnly(width, contentWidth) ? ACTION_ICON_SIZE : contentWidth;
  const edge = Math.min(ACTION_PADDING, (width - shown) / 2);
  const rest = side === "lead" ? edge : width - shown - edge;
  const rowEdge = side === "lead" ? width - shown - ACTION_PADDING : ACTION_PADDING;
  const x = rest + (rowEdge - rest) * armed;
  return x + ((width - shown) / 2 - x) * centered;
}

// ---- the comet ----

/** One lap of the comet, and the lap around the Undo strip. */
export const COMET_LAP_MS = 1150;
export const COMET_STRIP_LAP_MS = 1050;
/** It stays mounted this long after the lap, for the outline's glow to go. */
export const COMET_TAIL_MS = 200;
/** The outline's breath as the loop closes. */
export const COMET_RING_MS = 520;

export interface CometBox {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

/** Where the comet's outline sits inside its canvas: inset on each side. */
export interface CometOutlineInset {
  insetX: number;
  insetY: number;
  radius: number;
}

/**
 * The rounded outline as an SVG path, clockwise from the middle of the side
 * the action was on: up the left side first, or down the right.
 */
export function cometOutline(box: CometBox, from: "left" | "right"): string {
  "worklet";
  const { x: x0, y: y0, width, height } = box;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const r = Math.min(box.radius, width / 2, height / 2);
  const ym = (y0 + y1) / 2;
  const arc = (x: number, y: number) => `A ${r} ${r} 0 0 1 ${x} ${y}`;
  return from === "left"
    ? `M ${x0} ${ym} V ${y0 + r} ${arc(x0 + r, y0)} H ${x1 - r} ${arc(x1, y0 + r)} V ${y1 - r} ${arc(x1 - r, y1)} H ${x0 + r} ${arc(x0, y1 - r)} Z`
    : `M ${x1} ${ym} V ${y1 - r} ${arc(x1 - r, y1)} H ${x0 + r} ${arc(x0, y1 - r)} V ${y0 + r} ${arc(x0 + r, y0)} H ${x1 - r} ${arc(x1, y0 + r)} Z`;
}

/** Length of the outline. */
export function cometPerimeter(box: CometBox): number {
  "worklet";
  const r = Math.min(box.radius, box.width / 2, box.height / 2);
  return 2 * (box.width - 2 * r) + 2 * (box.height - 2 * r) + 2 * Math.PI * r;
}

/** Sine ease over the lap: slow away, quick round the far side, slow in. */
function sineInOut(t: number): number {
  "worklet";
  return (1 - Math.cos(Math.PI * t)) / 2;
}

/**
 * How far the head has run at `t` (0 to 1 of the lap). It carries on past
 * the start so the tail of the longest layer, `longest`, follows it home.
 */
export function cometHead(t: number, perimeter: number, longest: number): number {
  "worklet";
  return sineInOut(Math.min(1, Math.max(0, t))) * (perimeter + longest * 0.85);
}

/**
 * One layer of the comet as a trim of the outline: its `length` ends at the
 * head. Returns [start, end] as fractions of the outline.
 */
export function cometTrim(head: number, length: number, perimeter: number): [number, number] {
  "worklet";
  const clamp = (v: number) => (perimeter > 0 ? Math.min(1, Math.max(0, v / perimeter)) : 0);
  return [clamp(head - length), clamp(head)];
}

/** The comet's opacity over the lap: in quickly, out over the last 18%. */
export function cometOpacity(t: number): number {
  "worklet";
  const fadeIn = Math.min(1, t / 0.06);
  const fadeOut = t > 0.82 ? Math.max(0, 1 - (t - 0.82) / 0.18) : 1;
  return Math.max(0, fadeIn * fadeOut);
}

/** When (0 to 1 of the lap) the head closes the loop and the outline breathes. */
export function cometRingStart(perimeter: number, longest: number): number {
  "worklet";
  const share = (perimeter * 0.97) / (perimeter + longest * 0.85);
  return Math.acos(1 - 2 * Math.min(1, share)) / Math.PI;
}

/**
 * The outline's breath, `elapsed` ms after the ring starts: up and back down
 * once over {@link COMET_RING_MS} on an ease-out, peaking at `peak`.
 */
export function cometRingOpacity(elapsed: number, peak = 0.5): number {
  "worklet";
  if (elapsed <= 0 || elapsed >= COMET_RING_MS) return 0;
  const p = elapsed / COMET_RING_MS;
  // CSS ease-out, cubic-bezier(0, 0, .58, 1), closely enough.
  const eased = 1 - Math.pow(1 - p, 1.9);
  return peak * (eased < 0.5 ? eased * 2 : (1 - eased) * 2);
}
