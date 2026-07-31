/**
 * Display-only sorting for playlist track lists. Never touches the saved
 * playlist order on the server.
 *
 * The web and mobile playlist screens carried identical copies of the emoji
 * regex, the title key, the collator and the comparator — differing only in
 * how each reached the track fields (`entry.title` vs `row.entry.title`).
 * Taking a structural parameter rather than a whole row type is what lets one
 * comparator serve both.
 *
 * Sort option *labels* deliberately stay in the platform modules: they are UI
 * copy in different shapes (a `<Select>` option list on web, a context menu on
 * mobile) and the two legitimately word "Custom" differently.
 */

export type SortKey = "custom" | "title" | "duration" | "plays";

/**
 * Ascending feels natural for names and lengths; play counts read best
 * biggest-first.
 */
export const SORT_DEFAULT_ASC: Record<SortKey, boolean> = {
  custom: true,
  title: true,
  duration: true,
  plays: false,
};

// Emoji and pictographic symbols, mirroring the backend's share-card
// stripping, so "🔥 Song" sorts under S rather than before every letter.
// The ZWJ and variation-selector ranges are intentional: the point is to strip
// emoji sequences, not to match whole grapheme clusters.
const EMOJI_RE =
  // eslint-disable-next-line no-misleading-character-class
  /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;

/**
 * Collation key for a title: emoji stripped, whitespace collapsed. Falls back
 * to the original when stripping would leave nothing, so an all-emoji title
 * still sorts somewhere stable instead of collapsing to "".
 */
export function sortTitleKey(title: string): string {
  const stripped = title.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
  return stripped || title;
}

const titleCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

/** The track fields the comparator needs, whatever row type wraps them. */
export interface SortableTrack {
  title: string;
  duration_ms: number;
  play_count?: number | null;
}

/**
 * Compare two tracks by `key`. Every non-title key falls back to title order
 * so equal durations/play counts still produce a stable, alphabetical list.
 * `custom` returns 0 throughout, leaving the caller's original order intact.
 */
export function compareSortableTracks(
  a: SortableTrack,
  b: SortableTrack,
  key: SortKey,
): number {
  const byTitle = () =>
    titleCollator.compare(sortTitleKey(a.title), sortTitleKey(b.title));
  switch (key) {
    case "title":
      return byTitle();
    case "duration":
      return a.duration_ms - b.duration_ms || byTitle();
    case "plays":
      return (a.play_count ?? 0) - (b.play_count ?? 0) || byTitle();
    case "custom":
      return 0;
  }
}
