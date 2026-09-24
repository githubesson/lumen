import { useCallback, useEffect, useRef } from "react";
import { playableTracks, type TrackListItem } from "@music-library/core";
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
  // Ref updates belong in an effect: writing refs during render is illegal
  // under concurrent React (and rejected by the React Compiler).
  useEffect(() => {
    // Unavailable rows (dropped from TIDAL, no library copy) are never queued.
    tracksRef.current = playableTracks(tracks);
  }, [tracks]);
  return useCallback(
    (track: TrackListItem) => {
      if (!track.unavailable) play(track, tracksRef.current);
    },
    [play],
  );
}
