import type { PlaylistTrackEntry } from "../../api";
import type { SelectOption } from "../../components/Select";

// ── Local sorting ────────────────────────────────────────────────────────────
// Display-only: never touches the saved playlist order on the server.

export type SortKey = "custom" | "title" | "duration" | "plays";

export const SORT_OPTIONS: SelectOption<SortKey>[] = [
  { value: "custom", label: "Custom order" },
  { value: "title", label: "Title" },
  { value: "duration", label: "Length" },
  { value: "plays", label: "Plays" },
];

// Ascending feels natural for names and lengths; play counts read best
// biggest-first.
export const SORT_DEFAULT_ASC: Record<SortKey, boolean> = {
  custom: true,
  title: true,
  duration: true,
  plays: false,
};

// Emoji and pictographic symbols, mirroring the mobile app and the backend's
// share-card stripping, so "🔥 Song" sorts under S rather than before every
// letter.
const EMOJI_RE =
  /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;

function sortTitleKey(title: string): string {
  const stripped = title.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
  return stripped || title;
}

const titleCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

export function compareEntries(
  a: PlaylistTrackEntry,
  b: PlaylistTrackEntry,
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
