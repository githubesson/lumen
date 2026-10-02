import { sortTitleKey, type SortKey } from "@music-library/core/track-sort";
import { useMemo } from "react";
import type { PlaylistTrackEntry } from "../../api";
import type { SelectOption } from "../../components/Select";

// ── Local sorting ────────────────────────────────────────────────────────────
// Display-only: never touches the saved playlist order on the server.
//
// The comparator, title normalization and default directions come from core;
// the page passes core's comparator the title keys built here once per list.
// Custom order with no search builds no keys.

export {
  SORT_DEFAULT_ASC,
  compareSortableTracks as compareEntries,
  type SortKey,
} from "@music-library/core/track-sort";

export const SORT_OPTIONS: SelectOption<SortKey>[] = [
  { value: "custom", label: "Custom order" },
  { value: "title", label: "Title" },
  { value: "duration", label: "Length" },
  { value: "plays", label: "Plays" },
];

export function usePlaylistTrackKeys(tracks: PlaylistTrackEntry[] | null, sortKey: SortKey, query: string) {
  const sorting = sortKey !== "custom";
  const searching = query.length > 0;
  const titleKeys = useMemo(
    () => sorting ? new Map((tracks ?? []).map((track) => [track, sortTitleKey(track.title)])) : null,
    [tracks, sorting],
  );
  const searchKeys = useMemo(
    () => searching ? new Map((tracks ?? []).map((track) => [
      track,
      `${track.title} ${track.artist ?? ""} ${track.album_title ?? ""}`.toLowerCase(),
    ])) : null,
    [tracks, searching],
  );
  return { titleKeys, searchKeys };
}
