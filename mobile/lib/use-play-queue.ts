import type { TrackListItem } from "@music-library/core";
import { usePlayFromList } from "@music-library/core/player/play-list";
import { usePlayTrack } from "../context/player";

/**
 * Press handler for track lists: plays the pressed track with the whole list
 * as the queue (see core's `usePlayFromList`), bound to this app's player.
 */
export function usePlayQueue(tracks: TrackListItem[]) {
  return usePlayFromList(usePlayTrack(), tracks).playTrack;
}
