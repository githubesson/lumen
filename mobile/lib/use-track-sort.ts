import { useCallback, useState } from "react";
import * as Haptics from "expo-haptics";
import { SORT_DEFAULT_ASC, type SortKey } from "@music-library/core";

/** A track list's display-only sort: the key and its direction. */
export interface TrackSort {
  key: SortKey;
  asc: boolean;
}

export const DEFAULT_TRACK_SORT: TrackSort = { key: "custom", asc: SORT_DEFAULT_ASC.custom };

/**
 * Picking a key: the same one keeps its direction, another starts in its
 * natural one. Key and direction change in one update, so the updater stays
 * pure (React may run it twice) and back-to-back picks build on each other.
 */
export function selectTrackSort(prev: TrackSort, key: SortKey): TrackSort {
  return prev.key === key ? prev : { key, asc: SORT_DEFAULT_ASC[key] };
}

export function toggleTrackSortDirection(prev: TrackSort): TrackSort {
  return { ...prev, asc: !prev.asc };
}

/** Sort state and the sort menu's handlers for the mobile track lists. */
export function useTrackSort() {
  const [sort, setSort] = useState<TrackSort>(DEFAULT_TRACK_SORT);
  const onSelectSort = useCallback((key: SortKey) => {
    void Haptics.selectionAsync();
    setSort((prev) => selectTrackSort(prev, key));
  }, []);
  const onToggleSortDirection = useCallback(() => {
    setSort(toggleTrackSortDirection);
  }, []);
  /** Back to the list's own order (the playlist's reorder mode needs it). */
  const resetSort = useCallback(() => {
    setSort((prev) => selectTrackSort(prev, "custom"));
  }, []);
  return {
    sortKey: sort.key,
    sortAsc: sort.asc,
    onSelectSort,
    onToggleSortDirection,
    resetSort,
  };
}
