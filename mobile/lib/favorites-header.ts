import type { TrackListItem } from "@music-library/core";
import { formatTotalMs, pluralize } from "./format";

/**
 * The Favorites tab's two lists and the math behind its custom header: the
 * large title collapses into the nav bar while the heart | clock switch rises
 * out of the title row, shrinks, and docks into the bar's leading slot.
 *
 * Every offset here is `s`, the list's scroll distance from rest: 0 with the
 * header fully expanded, positive as content moves up, negative while pulling
 * to refresh. Header positions are relative to the header's top, which sits
 * just under the status bar at rest. The functions are worklets so the
 * screen's animated styles call the same code the tests cover.
 */

export type FavoritesMode = "favorites" | "recent";

export const FAVORITES_HEADER = {
  /** The nav bar under the status bar; the header pads its top by this. */
  navBarHeight: 44,
  /** Screen-edge margin of the title, the switch and the bar's buttons. */
  sideInset: 16,
  /** The title row: tall enough for the switch at its expanded size. */
  titleRowMinHeight: 53,
  /** The switch docked in the bar: two 52pt glyph slots in a 4pt inset. */
  switchWidth: 112,
  switchHeight: 44,
  /** The switch is a size up while it sits in the title row. */
  expandedScale: 1.2,
  /** Scroll over which the switch slides to the leading slot and shrinks. */
  morphDistance: 64,
  /**
   * The inline title shows once no more than this much of the large title's
   * line box is left below the bar: the empty space under its glyphs.
   */
  titleSliver: 3,
  /** Past this content is under the bar and the scroll edge shows. */
  edgeAt: 6,
  /** The header buttons are gone this far below the bar... */
  controlsFadeGap: 30,
  /** ...having faded over this distance. */
  controlsFadeDistance: 44,
} as const;

/** Where the header's parts sit, measured from the header's top. */
export interface HeaderGeometry {
  titleRowY: number;
  titleRowHeight: number;
  /** Bottom of the large title's text, which grows with the text size. */
  titleBottom: number;
  /** Bottom of the Shuffle / Play / Sort row (of the count line without it). */
  controlsBottom: number;
}

/** The layout the header renders before it has been measured. */
export const DEFAULT_HEADER_GEOMETRY: HeaderGeometry = {
  titleRowY: FAVORITES_HEADER.navBarHeight,
  titleRowHeight: FAVORITES_HEADER.titleRowMinHeight,
  // a 41pt line centred in the row
  titleBottom:
    FAVORITES_HEADER.navBarHeight + (FAVORITES_HEADER.titleRowMinHeight + 41) / 2,
  // count line 20 + controls row 14 + 50 + 10
  controlsBottom:
    FAVORITES_HEADER.navBarHeight + FAVORITES_HEADER.titleRowMinHeight + 94,
};

/**
 * The count line under the title. Favorites is a collection, so it gets a
 * running time; Recent is a play history, where a total means nothing.
 */
/**
 * The tracks that count, in order: a favorite removed with Undo still shows
 * (with its Undo strip) but already reads as removed, so the count line and
 * the play queues leave it out. Recent isn't affected.
 */
export function countedTracks<T extends Pick<TrackListItem, "id">>(
  mode: FavoritesMode,
  tracks: T[],
  pendingRemovalIds: ReadonlySet<string>,
): T[] {
  if (mode !== "favorites" || pendingRemovalIds.size === 0) return tracks;
  return tracks.filter((track) => !pendingRemovalIds.has(track.id));
}

export function listSummary(
  mode: FavoritesMode,
  tracks: readonly Pick<TrackListItem, "duration_ms">[],
): string {
  if (tracks.length === 0) return "";
  const songs = pluralize(tracks.length, "song");
  if (mode === "recent") return `${songs}, last played first`;
  const totalMs = tracks.reduce(
    (sum, track) =>
      sum + (Number.isFinite(track.duration_ms) ? Math.max(0, track.duration_ms) : 0),
    0,
  );
  return `${songs}, ${formatTotalMs(totalMs)}`;
}

function clamp01(t: number): number {
  "worklet";
  return Math.min(1, Math.max(0, t));
}

/** Ease in and out over 0…1. */
export function smoothstep(t: number): number {
  "worklet";
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export interface SwitchPlacement {
  /** Top-left corner on screen. */
  x: number;
  y: number;
  /** Size relative to the docked switch: expandedScale in the header, 1 docked. */
  scale: number;
}

/**
 * The switch at scroll `s`. Expanded it trails the large title, centred in
 * the title row; it moves up with the content until it meets the bar, while
 * sliding to the bar's leading slot and shrinking over `morphDistance`.
 */
export function switchPlacement(
  s: number,
  geometry: HeaderGeometry,
  barTop: number,
  screenWidth: number,
): SwitchPlacement {
  "worklet";
  const {
    sideInset,
    switchWidth,
    switchHeight,
    expandedScale,
    morphDistance,
  } = FAVORITES_HEADER;
  const expandedX = screenWidth - sideInset - switchWidth * expandedScale;
  const expandedY =
    barTop +
    geometry.titleRowY +
    (geometry.titleRowHeight - switchHeight * expandedScale) / 2;
  const p = smoothstep(s / morphDistance);
  return {
    x: expandedX * (1 - p) + sideInset * p,
    y: Math.max(barTop, expandedY - s),
    scale: expandedScale * (1 - p) + p,
  };
}

/**
 * How much of the title row's top is cut off at `s`: UIKit clips a large
 * title at the bar's bottom edge, so it never shows through the inline title.
 */
export function titleClip(s: number, geometry: HeaderGeometry): number {
  "worklet";
  const cut = s + FAVORITES_HEADER.navBarHeight - geometry.titleRowY;
  return Math.min(geometry.titleRowHeight, Math.max(0, cut));
}

/**
 * The large title has gone under the bar (all but its last sliver, empty
 * space under the glyphs), so the inline title takes over. Measured, so it
 * holds at larger text sizes.
 */
export function titleCollapsed(s: number, geometry: HeaderGeometry): boolean {
  "worklet";
  const { navBarHeight, titleSliver } = FAVORITES_HEADER;
  return s > geometry.titleBottom - navBarHeight - titleSliver;
}

/**
 * The header's Shuffle / Play / Sort fade out as they near the bar, gone
 * before they reach it, so the bright Play pill never smears under the edge.
 */
export function controlsOpacity(s: number, geometry: HeaderGeometry): number {
  "worklet";
  const { navBarHeight, controlsFadeGap, controlsFadeDistance } = FAVORITES_HEADER;
  const belowBar = geometry.controlsBottom - s - navBarHeight;
  return clamp01((belowBar - controlsFadeGap) / controlsFadeDistance);
}

/** The header's buttons have passed under the bar; the bar shows its own. */
export function controlsDocked(s: number, geometry: HeaderGeometry): boolean {
  "worklet";
  return geometry.controlsBottom - s < FAVORITES_HEADER.navBarHeight;
}

/** The first offset at which {@link controlsDocked} holds. */
export function collapsedOffset(geometry: HeaderGeometry): number {
  return Math.ceil(geometry.controlsBottom - FAVORITES_HEADER.navBarHeight + 1);
}

/**
 * Where the list being switched to should scroll, or null to leave it where
 * it was. Each list keeps its own position, but switching from the collapsed
 * bar keeps the header collapsed: a list resting above that point lands on
 * its first row under the bar instead of the big header.
 */
export function switchScrollTarget(
  fromOffset: number,
  toOffset: number,
  collapseAt: number,
): number | null {
  if (fromOffset < collapseAt || toOffset >= collapseAt) return null;
  return collapseAt;
}

/**
 * The furthest a list can be sent (as `s`). React Native's `scrollTo` clamps
 * to the content less the viewport, ignoring the status-bar inset.
 */
export function maxScrollOffset(
  contentHeight: number,
  viewportHeight: number,
  topInset: number,
): number {
  return Math.max(contentHeight - viewportHeight, 0) + topInset;
}

/**
 * What to do with a scroll a switch owes a list: wait while its rows haven't
 * loaded or been laid out, scroll now, or drop it when the list can't reach
 * that far. An empty or short list shows its header expanded, so the bar must
 * not be left collapsed over it.
 */
export function owedScrollStep(
  target: number,
  loaded: boolean,
  maxOffset: number | null,
): "wait" | "scroll" | "drop" {
  if (!loaded || maxOffset == null) return "wait";
  return maxOffset >= target ? "scroll" : "drop";
}

/** A scroll a switch owes the list it showed; only that list can owe one. */
export interface OwedScroll {
  list: FavoritesMode;
  target: number;
}

/**
 * What switching to `next` does with that list's scroll: scroll it now
 * (`scrollTo`), owe it until its rows are there (`owed`), or neither. The
 * owed scroll replaces any earlier one, which was owed to the list being left
 * (or to this one, the last time it showed): a list out of sight keeps its
 * own position.
 */
export function planSwitchScroll({
  next,
  fromOffset,
  toOffset,
  collapseAt,
  loaded,
  maxOffset,
}: {
  next: FavoritesMode;
  fromOffset: number;
  /** The list's offset, or null while it isn't mounted (it mounts at rest). */
  toOffset: number | null;
  collapseAt: number;
  loaded: boolean;
  maxOffset: number | null;
}): { scrollTo: number | null; owed: OwedScroll | null } {
  const target = switchScrollTarget(fromOffset, toOffset ?? 0, collapseAt);
  if (target == null) return { scrollTo: null, owed: null };
  const step = toOffset == null ? "wait" : owedScrollStep(target, loaded, maxOffset);
  if (step === "scroll") return { scrollTo: target, owed: null };
  if (step === "wait") return { scrollTo: null, owed: { list: next, target } };
  return { scrollTo: null, owed: null };
}
