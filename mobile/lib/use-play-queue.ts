import { useCallback, useRef } from "react";
import type { TrackListItem } from "@music-library/core";
import { usePlayTrack } from "../context/player";

/**
 * Press handler for track lists: plays the pressed track with the whole list
 * as the queue. The list is read through a ref so the handler identity stays
 * stable across data refreshes and memoized rows don't re-render. Previously
 * copy-pasted (ref + callback) in six screens.
 */
export function usePlayQueue(tracks: TrackListItem[]) {
  const play = usePlayTrack();
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  return useCallback(
    (track: TrackListItem) => play(track, tracksRef.current),
    [play],
  );
}
