import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TrackListItem } from "../api";
import {
  usePlaybackRemoteSession,
  type PlaybackDevice,
  type RemotePlaybackCommandResult,
} from "./activity-sync";
import type { PlayerControls, PlayerState, TimeState } from "./player-core";
import {
  controlledStateForDevice,
  remotePlayerState,
  useRemoteActivityClock,
  useRemotePlaybackCommands,
  useRemotePlaybackTarget,
} from "./remote-control";
import { useRoutedPlayerControls } from "./use-routed-player-controls";

/** The remote-playback slice both platforms put in their player context. */
export interface RemotePlaybackContextValue {
  /** This device's id in the playback session. */
  deviceId: string | null;
  connected: boolean;
  /** Other online devices that accept remote control. */
  remoteDevices: PlaybackDevice[];
  targetDeviceId: string | null;
  /** The device being controlled, or null while playing here. */
  targetDevice: PlaybackDevice | null;
  commandPending: boolean;
  lastCommandResult: RemotePlaybackCommandResult | null;
  /** Control another device (pausing local audio first), or null to play here. Stable. */
  selectTarget: (deviceId: string | null) => void;
}

export interface UseRemotePlaybackControllerOptions {
  /** The local player (`usePlayerCore`). */
  state: PlayerState;
  controls: PlayerControls;
  time: TimeState;
  /**
   * Whether anything can see the clock (app in the foreground, page visible).
   * While false the remote target's position stops ticking, like the local
   * player's `interpolateProgress`.
   */
  clockEnabled?: boolean;
  /** Platform policy and feedback, only applied when starting local playback. */
  canPlayLocally?: (track: TrackListItem) => boolean;
}

export interface UseRemotePlaybackControllerReturn {
  /** What the UI shows: the local player, or the selected device. */
  displayedState: PlayerState;
  /** The local clock, or the selected device's extrapolated position. */
  displayedTime: TimeState;
  /** Controls routed to the local player or the selected device. */
  controls: PlayerControls;
  remote: RemotePlaybackContextValue;
}

/**
 * Remote playback ("cast" mode) for a platform player provider: the playback
 * session, target selection, the controlled device's clock and optimistic
 * state, and controls routed to whichever device is selected.
 *
 * Platform integrations (media session, lock screen, Discord) stay in the
 * providers; they read `remote.targetDevice` to tell whether this device owns
 * playback.
 */
export function useRemotePlaybackController({
  state,
  controls,
  time,
  clockEnabled = true,
  canPlayLocally,
}: UseRemotePlaybackControllerOptions): UseRemotePlaybackControllerReturn {
  const session = usePlaybackRemoteSession();
  const { remoteDevices, targetDevice, targetDeviceId, setTargetDeviceId } =
    useRemotePlaybackTarget(session);
  // While controlling another device, time consumers (lyrics, most visibly)
  // need the target's clock, not the paused local one — and ticking, since
  // heartbeats only arrive every ~10s.
  const remoteTime = useRemoteActivityClock(targetDevice?.activity, clockEnabled);
  const {
    controlled,
    commandPending,
    lastCommandResult,
    sendCommand,
    seedControlled,
  } = useRemotePlaybackCommands({
    targetDeviceId,
    sourceDeviceId: session.deviceId,
    targetActivity: targetDevice?.activity,
    targetQueue: targetDevice?.queue,
    initialState: {
      volume: state.volume,
      muted: state.muted,
      shuffle: state.shuffle,
      repeat: state.repeat,
    },
  });

  // Read through a ref so this callback, handed to consumers through the
  // remote-playback context, keeps its identity while playback state moves
  // (every volume step would otherwise re-render every device-aware view).
  const selectTargetInputs = useRef({ controls, remoteDevices, state });
  useEffect(() => {
    selectTargetInputs.current = { controls, remoteDevices, state };
  });
  const selectTarget = useCallback(
    (nextDeviceId: string | null) => {
      const { controls, remoteDevices, state } = selectTargetInputs.current;
      const { isPlaying, muted, repeat, shuffle, volume } = state;
      if (nextDeviceId && isPlaying) controls.pause();
      setTargetDeviceId(nextDeviceId);
      seedControlled(
        controlledStateForDevice(
          remoteDevices.find((device) => device.deviceId === nextDeviceId),
          { volume, muted, shuffle, repeat },
        ),
      );
    },
    [seedControlled, setTargetDeviceId],
  );

  const displayedState = useMemo(
    () => (targetDevice ? remotePlayerState(targetDevice, controlled) : state),
    [targetDevice, controlled, state],
  );
  // No `remoteQueue`: jumps index the target's own queue snapshot, and a
  // target without one ignores them rather than having its queue replaced
  // by the single track shown for it.
  const routedControls = useRoutedPlayerControls({
    controls,
    targetDevice,
    controlled,
    sendCommand,
    canPlayLocally,
  });

  const { deviceId, connected } = session;
  const remote = useMemo<RemotePlaybackContextValue>(
    () => ({
      // Fields named outright: the session's full device list (this device
      // included) changes on every heartbeat and nothing here reads it.
      deviceId,
      connected,
      remoteDevices,
      targetDeviceId,
      targetDevice,
      commandPending,
      lastCommandResult,
      selectTarget,
    }),
    [
      commandPending,
      connected,
      deviceId,
      lastCommandResult,
      remoteDevices,
      selectTarget,
      targetDevice,
      targetDeviceId,
    ],
  );

  return {
    displayedState,
    displayedTime: targetDevice ? remoteTime : time,
    controls: routedControls,
    remote,
  };
}
