import type { TrackListItem } from "../api";

export type RepeatMode = "off" | "all" | "one";

/** Why the current track stopped: its source failed to load or play. */
export interface PlaybackError {
  trackId: string;
  /** Short and user-facing: the server's reason, or a generic one. */
  message: string;
  /** What happened, for a closer look or a bug report. */
  details: PlaybackErrorDetails;
}

/** The facts behind a `PlaybackError`. */
export interface PlaybackErrorDetails {
  /** When it failed, in ms since the epoch. */
  at: number;
  /** What the player was given: a server path, or a downloaded copy's URI. */
  source: string;
  /** What the audio player said about it; null when it said nothing. */
  player: string | null;
  /**
   * What the server answered when asked for the stream again. Undefined
   * while it's being asked; null when it wasn't (a downloaded copy).
   */
  server?: string | null;
}

export interface PlayerState {
  current: TrackListItem | null;
  queue: TrackListItem[];
  index: number;
  isPlaying: boolean;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /**
   * The current track's playback failure. Cleared when another track starts
   * or this one is played again (which retries it).
   */
  playbackError: PlaybackError | null;
}

/** How `play` starts its queue. */
export interface PlayOptions {
  /**
   * Set shuffle mode with this start. On shuffles the new queue with the
   * started track first and keeps the list's order for when shuffle goes off.
   * The mode only changes when the start is accepted, so a refused play
   * leaves it and the queue playing now alone.
   */
  shuffle?: boolean;
}

export interface PlayerControls {
  /** Returns false when local playback policy rejects the track. */
  play: (
    track: TrackListItem,
    queue?: TrackListItem[],
    options?: PlayOptions,
  ) => false | void;
  /**
   * Put `tracks` right after the current one, in both the play order and
   * the list order (so turning shuffle off keeps them next). Consecutive
   * calls queue up in the order they were made until the track changes. A
   * track already in the queue moves rather than appearing twice; the
   * current track and tracks that can't start are left out. With nothing
   * loaded it plays them. Returns whether anything was queued.
   */
  playNext: (tracks: TrackListItem[]) => boolean;
  resume: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  /** Jump to a specific position in the current queue. */
  jumpTo: (index: number) => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  setMuted: (muted: boolean) => void;
  toggleMute: () => void;
  setShuffle: (shuffle: boolean) => void;
  toggleShuffle: () => void;
  setRepeat: (repeat: RepeatMode) => void;
  cycleRepeat: () => void;
}

export interface TimeState {
  currentTime: number;
  duration: number;
}

/**
 * Fisher-Yates shuffle of `items`, with the track whose id is `anchorId`
 * pinned to index 0 so it stays playing when shuffle toggles on mid-track.
 * Returns a new array; never mutates the input.
 */
export function fisherYatesWithAnchor<T extends { id: string }>(
  items: T[],
  anchorId: string | null,
): T[] {
  const rest = [...items];
  const anchorIndex = anchorId === null ? -1 : rest.findIndex((t) => t.id === anchorId);
  const anchor = anchorIndex < 0 ? undefined : rest.splice(anchorIndex, 1)[0];
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return anchor ? [anchor, ...rest] : rest;
}

/**
 * `list` with `tracks` placed right after position `at` (the current track),
 * behind any leading run of ids in `run` (earlier Play Next picks), so a run
 * keeps the order it was picked in. Other copies of `tracks` are taken out
 * first, since the queue finds tracks by id, and the current track itself
 * stays where it is. Returns the new list and the current track's new
 * position. With `at` outside the list they go first.
 */
export function withPlayNext<T extends { id: string }>(
  list: readonly T[],
  at: number,
  tracks: readonly T[],
  run: ReadonlySet<string> = new Set(),
): { list: T[]; at: number } {
  if (at < 0 || at >= list.length) {
    const ids = new Set(tracks.map((track) => track.id));
    return { list: [...tracks, ...list.filter((track) => !ids.has(track.id))], at: -1 };
  }
  const picked = tracks.filter((track) => track.id !== list[at].id);
  const ids = new Set(picked.map((track) => track.id));
  const keep = (track: T) => !ids.has(track.id);
  const before = list.slice(0, at).filter(keep);
  const after = list.slice(at + 1).filter(keep);
  let runEnd = 0;
  while (runEnd < after.length && run.has(after[runEnd].id)) runEnd += 1;
  return {
    list: [
      ...before,
      list[at],
      ...after.slice(0, runEnd),
      ...picked,
      ...after.slice(runEnd),
    ],
    at: before.length,
  };
}

/**
 * Pure predicate: should we fire the "this track was played" report for the
 * current position? Mirrors the backend's criterion — 30s in OR >=50% done.
 */
export function shouldReportPlay(
  currentTime: number,
  duration: number,
): boolean {
  return currentTime >= 30 || (duration > 0 && currentTime / duration >= 0.5);
}

/** Cycle order for the repeat button: off → all → one → off. */
export function nextRepeatMode(r: RepeatMode): RepeatMode {
  return r === "off" ? "all" : r === "all" ? "one" : "off";
}

/**
 * Accessible label for the repeat button: the current mode, then what
 * pressing it does (the next mode in {@link nextRepeatMode}'s cycle).
 */
export function repeatModeLabel(repeat: RepeatMode): string {
  switch (repeat) {
    case "off":
      return "Repeat off. Turn on repeat";
    case "all":
      return "Repeat all. Turn on repeat one";
    case "one":
      return "Repeat one. Turn repeat off";
  }
}

/**
 * A playback position advanced by the time since it was sampled, capped at
 * the track's end. An unknown (zero or NaN) duration leaves it uncapped.
 */
export function extrapolatePosition(
  position: number,
  elapsedSeconds: number,
  duration: number,
): number {
  return Math.min(duration > 0 ? duration : Infinity, position + Math.max(0, elapsedSeconds));
}

/**
 * Whether the player may start `track`. Tracks flagged `unavailable` (dropped
 * from TIDAL with no library copy) can never stream; `isPlayable` is the
 * platform's own gate (e.g. not downloaded while offline).
 */
export function canStartTrack(
  track: Pick<TrackListItem, "id" | "unavailable">,
  isPlayable?: (trackId: string) => boolean,
): boolean {
  return !track.unavailable && (!isPlayable || isPlayable(track.id));
}

/** Smooth mix's crossfade lengths to choose from, in seconds. */
export const SMOOTH_MIX_SECONDS = [3, 6, 9, 12] as const;

/**
 * Whether `next` is the track after `current` on the same album, as when an
 * album plays in order. Smooth mix doesn't fade there: album tracks often run
 * into each other, and a fade would break the join.
 */
export function continuesAlbum(
  current: Pick<TrackListItem, "album_id" | "source" | "source_album_id" | "track_no">,
  next: Pick<TrackListItem, "album_id" | "source" | "source_album_id" | "track_no">,
): boolean {
  const sameAlbum =
    (!!current.album_id && current.album_id === next.album_id) ||
    (!!current.source_album_id &&
      current.source === next.source &&
      current.source_album_id === next.source_album_id);
  return sameAlbum && current.track_no != null && next.track_no === current.track_no + 1;
}

/** Clamp a volume value to [0, 1]. */
export function clampVolume(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Persisted volume storage key. */
export const VOLUME_STORAGE_KEY = "mlib-volume";
