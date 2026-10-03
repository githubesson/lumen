import type { TrackListItem } from "../api";

export type RepeatMode = "off" | "all" | "one";

/** Why the current track stopped: its source failed to load or play. */
export interface PlaybackError {
  trackId: string;
  /** Short and user-facing: the server's reason, or a generic one. */
  message: string;
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

export interface PlayerControls {
  /** Returns false when local playback policy rejects the track. */
  play: (track: TrackListItem, queue?: TrackListItem[]) => false | void;
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

/** Clamp a volume value to [0, 1]. */
export function clampVolume(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Persisted volume storage key. */
export const VOLUME_STORAGE_KEY = "mlib-volume";
