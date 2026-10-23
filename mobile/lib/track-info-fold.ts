/**
 * Track Info's hero, and how scrolling folds it into the player's compact
 * row pinned under the nav bar. The hero mirrors Now Playing: 28 side
 * padding, a 12-radius cover, then the title row. The compact row is the
 * player's compact mode: a 58 cover with the title and artists beside it.
 *
 * All offsets are from the top of the screen, which runs under the
 * transparent nav bar; `s` is the scroll offset.
 */
export const FOLD = {
  side: 28,
  coverTop: 8,
  coverRadius: 12,
  metaGap: 15,
  metaHeight: 52,
  compactCover: 58,
  compactRadius: 8,
  compactTop: 2,
  compactSide: 16,
  compactGap: 12,
  action: 36,
  actionGap: 10,
  /** Wider screens center a column this wide. */
  maxColumn: 600,
  maxCover: 420,
} as const;

export interface TrackInfoFold {
  /** The nav bar's height; the content starts under it. */
  top: number;
  /** The content column, centered on wide screens. */
  column: number;
  left: number;
  /** The hero cover's size, and how much of it the scroll folds away. */
  cover: number;
  fold: number;
  /** The content's room for the cover, above the title row. */
  spacer: number;
  /** The play and menu buttons' top beside the hero title, unscrolled. */
  actionsTop: number;
  /** The scroll offset at which those buttons reach the compact row and stay. */
  stick: number;
  /** The scroll offset from which the compact row is the one in use. */
  pin: number;
  reducedMotion: boolean;
}

/**
 * The fold for a `width`-wide screen under a `top`-high nav bar. `meta` is
 * the title row's measured frame, from the top of the content under the nav
 * bar, once it has one; the buttons ride beside it.
 */
export function trackInfoFold(
  width: number,
  top: number,
  reducedMotion: boolean,
  meta?: { y: number; height: number } | null,
): TrackInfoFold {
  const column = Math.min(width, FOLD.maxColumn);
  const left = (width - column) / 2;
  const cover = Math.max(
    FOLD.compactCover,
    Math.min(column - 2 * FOLD.side, FOLD.maxCover),
  );
  const fold = cover - FOLD.compactCover;
  const spacer = FOLD.coverTop + cover + FOLD.metaGap;
  const row = meta ?? { y: spacer, height: FOLD.metaHeight };
  const actionsTop = top + row.y + (row.height - FOLD.action) / 2;
  const pinnedActionsTop =
    top + FOLD.compactTop + (FOLD.compactCover - FOLD.action) / 2;
  const stick = Math.max(0, actionsTop - pinnedActionsTop);
  return {
    top,
    column,
    left,
    cover,
    fold,
    spacer,
    actionsTop,
    stick,
    // Halfway through the compact row's fade-in, or (no fold) once the
    // buttons stick.
    pin: reducedMotion ? stick : fold + 35,
    reducedMotion,
  };
}

const clamp01 = (value: number) => {
  "worklet";
  return Math.min(1, Math.max(0, value));
};

/** How far the cover has folded, 0 (the hero) to 1 (the compact cover). */
function foldProgress(s: number, f: TrackInfoFold): number {
  "worklet";
  return f.fold > 0 ? clamp01(s / f.fold) : 1;
}

/**
 * The hero cover's transform at `s`. Its bottom rides the content while it
 * shrinks to the compact cover's size and place; scaling rather than
 * resizing it keeps layout out of each frame, so the corner radius is
 * divided by the scale to come out right. Pulled down past the top, it
 * follows the content.
 */
export function coverFrame(s: number, f: TrackInfoFold) {
  "worklet";
  const p = foldProgress(s, f);
  const scale = (f.cover - f.fold * p) / f.cover;
  // Scaling is about the center; this keeps the top-left corner in place.
  const shrink = (f.cover * (1 - scale)) / 2;
  return {
    scale,
    translateX: -(FOLD.side - FOLD.compactSide) * p - shrink,
    translateY:
      -(FOLD.coverTop - FOLD.compactTop) * p - shrink + Math.max(0, -s),
    borderRadius:
      (FOLD.coverRadius - (FOLD.coverRadius - FOLD.compactRadius) * p) / scale,
  };
}

/**
 * The play and menu buttons' offset at `s`: they scroll with the title row
 * until they reach the compact row, then stay, easing out to its side
 * padding as they arrive (stepping there without the fold).
 */
export function actionsOffset(s: number, f: TrackInfoFold) {
  "worklet";
  const arrived = f.reducedMotion
    ? s >= f.stick
      ? 1
      : 0
    : f.stick > f.fold
      ? clamp01((s - f.fold) / (f.stick - f.fold))
      : 1;
  return {
    translateX: (FOLD.side - FOLD.compactSide) * arrived,
    translateY: -Math.min(s, f.stick),
  };
}

/**
 * Opacities at `s`: the compact row fades in once the cover has folded, its
 * backdrop just before, while the hero's title and album line fade out.
 * Without the fold, the compact row and backdrop simply appear at `pin` and
 * the hero scrolls away under them.
 */
export function foldOpacity(s: number, f: TrackInfoFold) {
  "worklet";
  if (f.reducedMotion) {
    const on = s >= f.pin ? 1 : 0;
    return { compact: on, backdrop: on, meta: 1, album: 1 };
  }
  return {
    compact: clamp01((s - f.fold) / 70),
    backdrop: clamp01((s - f.fold + 40) / 60),
    meta: 1 - clamp01((s - f.fold + 20) / 45),
    album: 1 - clamp01((s - f.fold + 10) / 40),
  };
}
