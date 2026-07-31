/**
 * Controlling *another* device's playback ("cast" mode).
 *
 * The web and mobile `PlayerProvider`s each grew a full copy of this: the same
 * optimistic-state reducer, the same 50-track queue window, the same field
 * pick, the same device filter, the same pending-command counter. They were
 * identical character-for-character, and the two places they had already
 * drifted were both in playback state — a web-local `nextRepeat` shadowing
 * core's `nextRepeatMode`, and two spellings of the position extrapolation.
 *
 * What stays in the platform providers is what genuinely differs: how a target
 * device is *resolved* (the phone keeps a snapshot so a transient dropout does
 * not eject you from the session; the web tracks the live list only), and how
 * commands are triggered (keyboard shortcuts vs. lock-screen controls).
 */

import { useCallback, useEffect, useState } from "react";
import type { PlaybackActivity, TrackListItem } from "../api";
import { clampVolume, type PlayerState, type RepeatMode, type TimeState } from "./player-core";
import {
  sendRemotePlaybackCommand,
  type PlaybackDevice,
  type RemotePlaybackCommandAction,
  type RemotePlaybackCommandResult,
} from "./activity-sync";

/**
 * The slice of playback state that belongs to the *controlled* device.
 *
 * While a remote target is selected the UI must not show the local player's
 * volume or repeat mode, and the target only reports back on its next activity
 * heartbeat — so this is held locally and advanced optimistically.
 */
export interface ControlledPlaybackState {
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
}

/**
 * Devices that can be controlled from here: everyone except this device, that
 * is online and has opted into remote control.
 */
export function filterRemoteDevices(
  devices: PlaybackDevice[],
  selfDeviceId: string | null,
): PlaybackDevice[] {
  return devices.filter(
    (device) =>
      device.deviceId !== selfDeviceId &&
      device.online &&
      device.controlEnabled,
  );
}

/**
 * Advance the controlled state for a command the target accepted, so the UI
 * responds immediately instead of waiting a heartbeat. Unrecognized or
 * malformed arguments return the state unchanged rather than guessing.
 *
 * Setting a non-zero volume also clears mute, matching what every player does
 * when you drag the slider up from silence.
 */
export function optimisticControlledState(
  state: ControlledPlaybackState,
  action: RemotePlaybackCommandAction,
  args: Record<string, unknown>,
): ControlledPlaybackState {
  switch (action) {
    case "set_volume":
      return typeof args.volume === "number"
        ? {
            ...state,
            volume: clampVolume(args.volume),
            muted: args.volume > 0 ? false : state.muted,
          }
        : state;
    case "set_muted":
      return typeof args.muted === "boolean"
        ? { ...state, muted: args.muted }
        : state;
    case "set_shuffle":
      return typeof args.shuffle === "boolean"
        ? { ...state, shuffle: args.shuffle }
        : state;
    case "set_repeat":
      return args.repeat === "off" || args.repeat === "all" || args.repeat === "one"
        ? { ...state, repeat: args.repeat }
        : state;
    default:
      return state;
  }
}

/**
 * A window of at most 50 tracks around the selected one, for sending as the
 * remote queue. Whole libraries are far too large to push over a command, and
 * the receiving device only needs enough context to run next/previous.
 *
 * The window starts 24 tracks back so "previous" works immediately after a
 * hand-off. If the selected track somehow falls outside the window, the queue
 * degrades to just that track rather than silently playing something else.
 */
export function buildRemoteQueue(
  track: TrackListItem,
  queue?: TrackListItem[],
): TrackListItem[] {
  const source = queue?.length ? queue : [track];
  const selectedIndex = Math.max(
    0,
    source.findIndex((item) => item.id === track.id),
  );
  const start = Math.max(0, Math.min(selectedIndex - 24, source.length - 50));
  const window = source.slice(start, start + 50);
  return window.some((item) => item.id === track.id) ? window : [track];
}

/**
 * Strip a track to the fields the receiving device needs. Track rows can carry
 * large incidental payloads, and a 50-track queue multiplies whatever is left
 * on them by fifty.
 */
export function compactRemoteTrack(track: TrackListItem): TrackListItem {
  return {
    id: track.id,
    db_track_id: track.db_track_id,
    source: track.source,
    source_id: track.source_id,
    source_album_id: track.source_album_id,
    title: track.title,
    album_id: track.album_id,
    album_title: track.album_title,
    track_no: track.track_no,
    duration_ms: track.duration_ms,
    artist: track.artist,
    aka: track.aka,
    favorited: track.favorited,
    has_cover: track.has_cover,
    cover_url: track.cover_url,
    owned: track.owned,
  };
}

/**
 * The remote device's current position, extrapolated forward from the
 * heartbeat that reported it. Activity arrives every few seconds, so without
 * this the scrubber would visibly tick in jumps.
 *
 * Only a *playing* target advances; a paused one sits where it was reported.
 * Both are clamped to the track duration — the web copy skipped the clamp on
 * the paused branch, which let a stale heartbeat render a position past the
 * end of the track.
 */
export function remoteActivityTime(
  activity: PlaybackActivity | null | undefined,
): TimeState {
  if (!activity) return { currentTime: 0, duration: 0 };
  const duration = activity.duration_sec ?? 0;
  const updatedAt = Date.parse(activity.updated_at);
  const elapsed =
    activity.is_playing && Number.isFinite(updatedAt)
      ? Math.max(0, (Date.now() - updatedAt) / 1000)
      : 0;
  return {
    currentTime: Math.min(duration || Infinity, activity.position_sec + elapsed),
    duration,
  };
}

/** Cadence for re-extrapolating a remote target's position between heartbeats. */
const REMOTE_CLOCK_TICK_MS = 250;

/**
 * {@link remoteActivityTime}, kept ticking. Heartbeats arrive every ~10s and
 * the extrapolation is only as fresh as its last call, so reading it from a
 * memo keyed on the heartbeat makes the position — and everything derived from
 * it, like synced lyrics — advance in ten-second leaps. This re-evaluates on a
 * timer while the target reports playing, matching the 250ms cadence local
 * playback gets from the rAF interpolation loop.
 *
 * `enabled` lets a platform stop the ticking when nothing is watching (the
 * phone passes its foreground state). A paused or absent target does not tick
 * either; its position is re-read only when the next heartbeat arrives.
 */
export function useRemoteActivityClock(
  activity: PlaybackActivity | null | undefined,
  enabled = true,
): TimeState {
  // Seeded from an effect rather than the initializer: `remoteActivityTime`
  // reads the wall clock, which render-phase code must not.
  const [time, setTime] = useState<TimeState>({ currentTime: 0, duration: 0 });
  const playing = !!activity?.is_playing;
  useEffect(() => {
    // Keep the previous state object when the values are unchanged. This is
    // what stops re-render feedback for callers whose `activity` is a fresh
    // object every render: without the bailout, effect → set → render → new
    // activity → effect never reaches a fixed point.
    const sync = () => {
      const raw = remoteActivityTime(activity);
      // Same 250ms quantization local playback applies to its time state:
      // consumers re-render on the tick grid, not on every wall-clock read.
      const step = REMOTE_CLOCK_TICK_MS / 1000;
      const next = {
        currentTime: Math.round(raw.currentTime / step) * step,
        duration: raw.duration,
      };
      setTime((prev) =>
        prev.currentTime === next.currentTime && prev.duration === next.duration
          ? prev
          : next,
      );
    };
    sync();
    if (!enabled || !playing) return;
    const interval = setInterval(sync, REMOTE_CLOCK_TICK_MS);
    return () => clearInterval(interval);
  }, [activity, enabled, playing]);
  return time;
}

/**
 * The remote device's current track as a `TrackListItem`, so the same now-playing
 * UI can render local and remote playback without branching.
 */
export function activityTrack(
  activity: PlaybackActivity | null | undefined,
): TrackListItem | null {
  if (!activity) return null;
  return {
    id: activity.track_id,
    title: activity.title,
    artist: activity.artist,
    album_id: activity.album_id,
    album_title: activity.album,
    cover_url: activity.cover_url,
    duration_ms: (activity.duration_sec ?? 0) * 1000,
  };
}

export interface UseRemotePlaybackCommandsOptions {
  /** Device being controlled, or null when playing locally. */
  targetDeviceId: string | null;
  /** This device's id, echoed back in the result of a failed send. */
  sourceDeviceId: string | null;
  /** Latest heartbeat from the target; drives volume/mute reconciliation. */
  targetActivity: PlaybackActivity | null | undefined;
  /** Seed for the controlled state before any target is picked. */
  initialState: ControlledPlaybackState;
}

export interface UseRemotePlaybackCommandsReturn {
  controlled: ControlledPlaybackState;
  commandPending: boolean;
  lastCommandResult: RemotePlaybackCommandResult | null;
  sendCommand: (
    action: RemotePlaybackCommandAction,
    args?: Record<string, unknown>,
  ) => Promise<RemotePlaybackCommandResult>;
  /**
   * Reseed the controlled state and clear the last result. Call when switching
   * targets — the new device's volume and mute have nothing to do with the old
   * one's, and a stale error banner from the previous session is misleading.
   */
  seedControlled: (seed: ControlledPlaybackState) => void;
}

/**
 * Command dispatch and optimistic controlled state for a remote target.
 *
 * The pending count is a counter rather than a boolean because commands
 * overlap — holding a volume key fires several, and a boolean would clear the
 * spinner when the first one lands rather than the last.
 */
export function useRemotePlaybackCommands({
  targetDeviceId,
  sourceDeviceId,
  targetActivity,
  initialState,
}: UseRemotePlaybackCommandsOptions): UseRemotePlaybackCommandsReturn {
  const [controlled, setControlled] = useState<ControlledPlaybackState>(
    () => initialState,
  );
  const [pendingCommandCount, setPendingCommandCount] = useState(0);
  const [lastCommandResult, setLastCommandResult] =
    useState<RemotePlaybackCommandResult | null>(null);

  const activityVolume = targetActivity?.volume;
  const activityMuted = targetActivity?.muted;

  // Reconcile against what the target actually reports. Only volume and mute:
  // shuffle and repeat are not carried on the activity payload, so they stay
  // wherever the last accepted command left them.
  useEffect(() => {
    if (!targetActivity) return;
    setControlled((current) => ({
      ...current,
      volume:
        typeof activityVolume === "number"
          ? clampVolume(activityVolume)
          : current.volume,
      muted: typeof activityMuted === "boolean" ? activityMuted : current.muted,
    }));
    // `targetActivity` itself is a fresh object on every heartbeat; depending
    // on it would re-run this on each poll even when nothing changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityVolume, activityMuted]);

  const seedControlled = useCallback((seed: ControlledPlaybackState) => {
    setControlled(seed);
    setLastCommandResult(null);
  }, []);

  const sendCommand = useCallback<
    UseRemotePlaybackCommandsReturn["sendCommand"]
  >(
    async (action, args = {}) => {
      if (!targetDeviceId) {
        const result: RemotePlaybackCommandResult = {
          commandId: "",
          sourceDeviceId: sourceDeviceId ?? "",
          targetDeviceId: "",
          status: "disconnected",
          error: "no remote playback device selected",
        };
        setLastCommandResult(result);
        return result;
      }
      setPendingCommandCount((count) => count + 1);
      try {
        const result = await sendRemotePlaybackCommand(
          targetDeviceId,
          action,
          args,
        );
        if (result.status === "applied") {
          setControlled((current) =>
            optimisticControlledState(current, action, args),
          );
        }
        setLastCommandResult(result);
        return result;
      } finally {
        setPendingCommandCount((count) => Math.max(0, count - 1));
      }
    },
    [sourceDeviceId, targetDeviceId],
  );

  return {
    controlled,
    commandPending: pendingCommandCount > 0,
    lastCommandResult,
    sendCommand,
    seedControlled,
  };
}

/** Seed for {@link useRemotePlaybackCommands.seedControlled} when picking a target. */
export function controlledStateForDevice(
  device: PlaybackDevice | null | undefined,
  fallback: Pick<PlayerState, "volume" | "muted" | "shuffle" | "repeat">,
): ControlledPlaybackState {
  const activity = device?.activity;
  return {
    volume:
      typeof activity?.volume === "number"
        ? clampVolume(activity.volume)
        : fallback.volume,
    muted:
      typeof activity?.muted === "boolean" ? activity.muted : fallback.muted,
    shuffle: fallback.shuffle,
    repeat: fallback.repeat,
  };
}
