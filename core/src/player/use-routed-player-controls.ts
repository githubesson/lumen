import { useCallback, useMemo } from "react";
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

export interface RoutedPlayerControlsOptions {
  controls: PlayerControls;
  targetDevice: PlaybackDevice | null;
  controlled: ControlledPlaybackState;
  sendCommand: (
    action: RemotePlaybackCommandAction,
    args?: Record<string, unknown>,
  ) => Promise<RemotePlaybackCommandResult>;
  remoteQueue: TrackListItem[];
  /** Platform policy and feedback, only applied when starting local playback. */
  canPlayLocally?: (track: TrackListItem) => boolean;
  /** Keep a platform's queue snapshot only after the target accepts play. */
  onRemoteQueueApplied?: (queue: TrackListItem[]) => void;
}

/** One control surface for local audio and a selected remote playback device. */
export function useRoutedPlayerControls({
  controls,
  targetDevice,
  controlled,
  sendCommand,
  remoteQueue,
  canPlayLocally,
  onRemoteQueueApplied,
}: RoutedPlayerControlsOptions): PlayerControls {
  const play = useCallback<PlayerControls["play"]>(
    (track, queue) => {
      if (!targetDevice) {
        if (canPlayLocally && !canPlayLocally(track)) return;
        controls.play(track, queue);
        return;
      }
      const nextQueue = buildRemoteQueue(track, queue);
      void sendCommand("play_track", {
        track: compactRemoteTrack(track),
        queue: nextQueue.map(compactRemoteTrack),
      }).then((result) => {
        if (result.status === "applied") onRemoteQueueApplied?.(nextQueue);
      });
    },
    [canPlayLocally, controls, onRemoteQueueApplied, sendCommand, targetDevice],
  );

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
        if (targetDevice)
          void sendCommand("set_volume", { volume: clampVolume(volume) });
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
      targetDevice,
    ],
  );
}
