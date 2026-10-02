import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TrackListItem } from "../api";
import { playableTracks } from "../track";
import type { PlayerControls } from "./player-core";

export interface PlayFromList {
  /** Play `track` with the list as the queue. Unavailable tracks are ignored. */
  playTrack: (track: TrackListItem) => void;
  /** The list's playable tracks, for other actions that queue the list. */
  getQueue: () => TrackListItem[];
}

/**
 * Press handling for a track list. Unavailable rows (dropped from TIDAL, no
 * library copy) are listed but never queued. The queue is read through a ref
 * so both functions keep their identity across data refreshes and memoized
 * rows don't re-render.
 */
export function usePlayFromList(
  play: PlayerControls["play"],
  tracks: readonly TrackListItem[],
): PlayFromList {
  const queue = useMemo(() => playableTracks(tracks), [tracks]);
  const queueRef = useRef(queue);
  // Refreshed from an effect rather than during render: a discarded render
  // must not mutate a ref. Every reader is an event handler, so a tick of lag
  // is harmless.
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  const playTrack = useCallback(
    (track: TrackListItem) => {
      if (!track.unavailable) play(track, queueRef.current);
    },
    [play],
  );
  const getQueue = useCallback(() => queueRef.current, []);
  return useMemo(() => ({ playTrack, getQueue }), [playTrack, getQueue]);
}

export interface ListPlaybackState {
  /**
   * A track of this list is the current one. Without a play-context id this
   * is the closest signal that the list's play button should pause instead of
   * restarting it.
   */
  playingHere: boolean;
  /** The play button shows pause. */
  showPause: boolean;
  /** The list has something that can be played. */
  canPlay: boolean;
}

/** State of a list's play button (an artist's or an album's). */
export function listPlaybackState(
  tracks: readonly TrackListItem[],
  current: Pick<TrackListItem, "id"> | null | undefined,
  isPlaying: boolean,
): ListPlaybackState {
  const playingHere = current != null && tracks.some((track) => track.id === current.id);
  return {
    playingHere,
    showPause: playingHere && isPlaying,
    canPlay: tracks.some((track) => !track.unavailable),
  };
}

/**
 * Start a list from its first playable track, or from a random one when
 * shuffle is on (shuffle keeps the starting track first, so starting at the
 * top would make every shuffled play open with the same song). Returns false
 * when nothing in the list can be played.
 */
export function startListPlayback(
  play: PlayerControls["play"],
  tracks: readonly TrackListItem[],
  shuffle: boolean,
  random: () => number = Math.random,
): boolean {
  const queue = playableTracks(tracks);
  if (!queue.length) return false;
  const start = shuffle
    ? queue[Math.min(queue.length - 1, Math.floor(random() * queue.length))]
    : queue[0];
  return play(start, queue) !== false;
}
