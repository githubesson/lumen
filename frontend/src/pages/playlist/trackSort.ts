import { sortTitleKey, type SortKey } from "@music-library/core/track-sort";
import { useMemo } from "react";
import type { PlaylistTrackEntry } from "../../api";
import type { SelectOption } from "../../components/Select";

// ── Local sorting ────────────────────────────────────────────────────────────
// Display-only: never touches the saved playlist order on the server.
//
// Title normalization and default directions come from core. The web's
// comparator uses precomputed keys, with ordering checked against core's
// comparator. Custom order with no search builds no keys.

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

const titleCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function compareIndexedEntries(
  a: PlaylistTrackEntry,
  b: PlaylistTrackEntry,
  key: SortKey,
  titleKeys: ReadonlyMap<PlaylistTrackEntry, string>,
): number {
  const byTitle = () => titleCollator.compare(titleKeys.get(a)!, titleKeys.get(b)!);
  switch (key) {
    case "title": return byTitle();
    case "duration": return a.duration_ms - b.duration_ms || byTitle();
    case "plays": return (a.play_count ?? 0) - (b.play_count ?? 0) || byTitle();
    case "custom": return 0;
  }
}
