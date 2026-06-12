import type { TrackListItem } from "../api";

export type RepeatMode = "off" | "all" | "one";

export interface PlayerState {
  current: TrackListItem | null;
  queue: TrackListItem[];
  index: number;
  isPlaying: boolean;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
}

export interface PlayerControls {
  play: (track: TrackListItem, queue?: TrackListItem[]) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  /** Jump to a specific position in the current queue. */
  jumpTo: (index: number) => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
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
  const rest = items.filter((t) => t.id !== anchorId);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const anchor = anchorId ? items.find((t) => t.id === anchorId) : undefined;
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

/** Clamp a volume value to [0, 1]. */
export function clampVolume(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Persisted volume storage key. */
export const VOLUME_STORAGE_KEY = "mlib-volume";
