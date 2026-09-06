import {
  SORT_DEFAULT_ASC,
  compareSortableTracks,
  type SortKey,
} from "@music-library/core/track-sort";
import type { PlaylistTrackEntry } from "../../api";
import type { SelectOption } from "../../components/Select";

// ── Local sorting ────────────────────────────────────────────────────────────
// Display-only: never touches the saved playlist order on the server.
//
// The comparator, the emoji-stripped collation key and the default directions
// live in `core/src/track-sort.ts` — the mobile playlist screen had an
// identical copy. Only the option list stays here: it is `<Select>`-shaped and
// worded for a desktop dropdown ("Custom order" rather than the phone's
// "Custom").

export { SORT_DEFAULT_ASC, type SortKey };

export const SORT_OPTIONS: SelectOption<SortKey>[] = [
  { value: "custom", label: "Custom order" },
  { value: "title", label: "Title" },
  { value: "duration", label: "Length" },
  { value: "plays", label: "Plays" },
];

export function compareEntries(
  a: PlaylistTrackEntry,
  b: PlaylistTrackEntry,
  key: SortKey,
): number {
  return compareSortableTracks(a, b, key);
}
