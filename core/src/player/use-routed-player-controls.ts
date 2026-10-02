import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TrackListItem } from "../api";
import type {
  PlaybackDevice,
  RemotePlaybackCommandAction,
  RemotePlaybackCommandResult,
} from "./activity-sync";
import {
  clampVolume,
  nextRepeatMode,
  type PlayerControls,
} from "./player-core";
import {
  buildRemoteQueue,
  compactRemoteTrack,
  type ControlledPlaybackState,
} from "./remote-control";

type SendRemoteCommand = (
  action: RemotePlaybackCommandAction,
  args?: Record<string, unknown>,
) => Promise<RemotePlaybackCommandResult>;

export interface RoutedPlayerControlsOptions {
  controls: PlayerControls;
  targetDevice: PlaybackDevice | null;
  controlled: ControlledPlaybackState;
  sendCommand: SendRemoteCommand;
  /**
   * Queue to replay from when `jumpTo` targets a device that reports no queue
   * snapshot, for a platform that keeps its own copy of what it sent (see
   * `onRemoteQueueApplied`). Leave unset otherwise: a device without a
   * snapshot then ignores jumps instead of having its queue replaced by
   * whatever is on screen.
   */
  remoteQueue?: TrackListItem[];
  /** Platform policy and feedback, only applied when starting local playback. */
  canPlayLocally?: (track: TrackListItem) => boolean;
  /** Keep a platform's queue snapshot only after the target accepts play. */
  onRemoteQueueApplied?: (queue: TrackListItem[]) => void;
}

/**
 * Minimum gap between `set_volume` commands to a remote device. A slider drag
 * changes the volume on every pointer move; each one would otherwise be a
 * socket round trip and a pending-command tick on the controller.
 */
export const REMOTE_VOLUME_INTERVAL_MS = 80;

const NO_TRACKS: TrackListItem[] = [];

/**
 * `set_volume` for the selected device, at most once per
 * {@link REMOTE_VOLUME_INTERVAL_MS}. The newest value inside an interval
 * replaces older ones and is always sent when it ends, so a drag lands where
 * it was released. A value still waiting when the target changes (or the
 * player unmounts) is sent at once, to the device it was meant for.
 */
function useThrottledRemoteVolume(sendCommand: SendRemoteCommand) {
  const throttle = useRef<{
    lastSentAt: number;
    pending: number | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ lastSentAt: -Infinity, pending: null, timer: null });

  useEffect(() => {
    const state = throttle.current;
    return () => {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
      state.lastSentAt = -Infinity;
      const pending = state.pending;
      state.pending = null;
      if (pending !== null) void sendCommand("set_volume", { volume: pending });
    };
  }, [sendCommand]);

  return useCallback(
    (volume: number) => {
      const state = throttle.current;
      const wait = REMOTE_VOLUME_INTERVAL_MS - (Date.now() - state.lastSentAt);
      if (wait <= 0 && state.timer === null) {
        state.lastSentAt = Date.now();
        void sendCommand("set_volume", { volume });
        return;
      }
      state.pending = volume;
      if (state.timer !== null) return;
      state.timer = setTimeout(() => {
        state.timer = null;
        const value = state.pending;
        state.pending = null;
        if (value === null) return;
        state.lastSentAt = Date.now();
        void sendCommand("set_volume", { volume: value });
      }, Math.max(0, wait));
    },
    [sendCommand],
  );
}

/** One control surface for local audio and a selected remote playback device. */
export function useRoutedPlayerControls({
  controls,
  targetDevice,
  controlled,
  sendCommand,
  remoteQueue = NO_TRACKS,
  canPlayLocally,
  onRemoteQueueApplied,
}: RoutedPlayerControlsOptions): PlayerControls {
  const localPlay = controls.play;
  const play = useCallback<PlayerControls["play"]>(
    (track, queue) => {
      // No device can play these, and checking first keeps a platform's
      // offline feedback from misreporting why.
      if (track.unavailable) return false;
      if (!targetDevice) {
        if (canPlayLocally && !canPlayLocally(track)) return false;
        return localPlay(track, queue);
      }
      const nextQueue = buildRemoteQueue(track, queue);
      void sendCommand("play_track", {
        track: compactRemoteTrack(track),
        queue: nextQueue.map(compactRemoteTrack),
      }).then((result) => {
        if (result.status === "applied") onRemoteQueueApplied?.(nextQueue);
      });
    },
    [canPlayLocally, localPlay, onRemoteQueueApplied, sendCommand, targetDevice],
  );
  const sendVolume = useThrottledRemoteVolume(sendCommand);

  return useMemo<PlayerControls>(
    () => ({
      play,
      resume: () => {
        if (targetDevice) void sendCommand("set_playing", { playing: true });
        else controls.resume();
      },
      pause: () => {
        if (targetDevice) void sendCommand("set_playing", { playing: false });
        else controls.pause();
      },
      toggle: () => {
        if (targetDevice)
          void sendCommand("set_playing", {
            playing: !targetDevice.activity?.is_playing,
          });
        else controls.toggle();
      },
      next: () => {
        if (targetDevice) void sendCommand("next");
        else controls.next();
      },
      prev: () => {
        if (targetDevice) void sendCommand("previous");
        else controls.prev();
      },
      jumpTo: (index) => {
        if (!targetDevice) controls.jumpTo(index);
        else if (targetDevice.queue?.tracks[index]) {
          void sendCommand("jump_to", {
            index: targetDevice.queue.offset + index,
            track_id: targetDevice.queue.tracks[index].id,
            queue_revision: targetDevice.queue.revision,
          });
        } else if (!targetDevice.queue && remoteQueue[index]) {
          play(remoteQueue[index], remoteQueue);
        }
      },
      seek: (seconds) => {
        if (targetDevice) void sendCommand("seek", { position_sec: seconds });
        else controls.seek(seconds);
      },
      setVolume: (volume) => {
        if (targetDevice) sendVolume(clampVolume(volume));
        else controls.setVolume(volume);
      },
      setMuted: (muted) => {
        if (targetDevice) void sendCommand("set_muted", { muted });
        else controls.setMuted(muted);
      },
      toggleMute: () => {
        if (targetDevice)
          void sendCommand("set_muted", { muted: !controlled.muted });
        else controls.toggleMute();
      },
      setShuffle: (shuffle) => {
        if (targetDevice) void sendCommand("set_shuffle", { shuffle });
        else controls.setShuffle(shuffle);
      },
      toggleShuffle: () => {
        if (targetDevice)
          void sendCommand("set_shuffle", { shuffle: !controlled.shuffle });
        else controls.toggleShuffle();
      },
      setRepeat: (repeat) => {
        if (targetDevice) void sendCommand("set_repeat", { repeat });
        else controls.setRepeat(repeat);
      },
      cycleRepeat: () => {
        if (targetDevice)
          void sendCommand("set_repeat", {
            repeat: nextRepeatMode(controlled.repeat),
          });
        else controls.cycleRepeat();
      },
    }),
    [
      controls,
      controlled.muted,
      controlled.shuffle,
      controlled.repeat,
      play,
      remoteQueue,
      sendCommand,
      sendVolume,
      targetDevice,
    ],
  );
}
