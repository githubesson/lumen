import { playableTracks, type TrackListItem } from "@music-library/core";
import { usePlayFromList } from "@music-library/core/player/play-list";
import { isPlayingRemotely, usePlayTrack } from "../context/player";
import { startableTracks } from "./offline-mode";

/**
 * Press handler for track lists: plays the pressed track with the whole list
 * as the queue (see core's `usePlayFromList`), bound to this app's player.
 */
export function usePlayQueue(tracks: TrackListItem[]) {
  return usePlayFromList(usePlayTrack(), tracks).playTrack;
}

/**
 * The tracks a list's Play and Shuffle buttons can start with. Played here
 * while offline, that's the downloaded ones; another device streams for
 * itself, so it gets every available track.
 */
export function startableListTracks<T extends TrackListItem>(tracks: readonly T[] = []): T[] {
  return isPlayingRemotely() ? playableTracks(tracks) : startableTracks(tracks);
}

/**
 * What a list's Play and Shuffle buttons queue: the startable tracks, so a
 * list whose first track isn't downloaded still plays offline rather than
 * stopping at "Not available offline". With none startable it's every
 * available track, so the attempt still explains why nothing plays.
 */
export function listPlaybackQueue<T extends TrackListItem>(tracks: readonly T[]): T[] {
  const startable = startableListTracks(tracks);
  return startable.length ? startable : playableTracks(tracks);
}
