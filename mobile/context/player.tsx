import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  setAudioModeAsync,
  type AudioLockScreenOptions,
  type AudioMetadata,
} from "expo-audio";
import { Alert, AppState, Platform } from "react-native";
import * as Haptics from "expo-haptics";
import {
  remotePlayerState,
  controlledStateForDevice,
  filterRemoteDevices,
  trackCoverUrl,
  useRemoteActivityClock,
  useRemotePlaybackCommands,
  usePlaybackActivityPublisher,
  usePlaybackRemoteSession,
  usePlayerCore,
  useRoutedPlayerControls,
  type PlaybackDevice,
  type PlayerControls,
  type PlayerState,
  type RemotePlaybackCommandResult,
  type TrackListItem,
  type TimeState,
} from "@music-library/core";
import { useExpoAudioAdapter } from "../adapters/expo-audio-adapter";
import { asyncStorageAdapter } from "../adapters/async-storage-adapter";
import { shouldExposeNowPlayingSession } from "./now-playing-session";
import { downloadStore } from "../lib/downloads";
import { isTrackPlayableOffline } from "../lib/offline-mode";
import {
  addLockScreenCommandListener,
  isLockScreenControlsAvailable,
  setLockScreenTrackControlsEnabled,
} from "../modules/lock-screen-controls";

type Ctx = PlayerState & PlayerControls;
type PlayerQueueState = Pick<PlayerState, "queue" | "index">;
type PlayerPlaybackState = Pick<
  PlayerState,
  "isPlaying" | "shuffle" | "repeat"
>;
type PlayerVolumeState = Pick<PlayerState, "volume" | "muted">;
type RemotePlaybackContextValue = {
  deviceId: string | null;
  connected: boolean;
  remoteDevices: PlaybackDevice[];
  targetDeviceId: string | null;
  targetDevice: PlaybackDevice | null;
  commandPending: boolean;
  lastCommandResult: RemotePlaybackCommandResult | null;
  selectTarget: (deviceId: string | null) => void;
};

/**
 * Context + throw-if-unmounted hook pair. The provider split below is
 * intentional (each slice re-renders independently); this only removes the
 * nine copy-pasted guard hooks. `undefined` is the "no provider" sentinel —
 * provided values are never `undefined` (the current track is `null` when
 * nothing is loaded).
 */
function createRequiredContext<T>(hookName: string) {
  const Ctx = createContext<T | undefined>(undefined);
  function useRequiredContext(): T {
    const value = useContext(Ctx);
    if (value === undefined) {
      throw new Error(`${hookName} requires PlayerProvider`);
    }
    return value;
  }
  return [Ctx, useRequiredContext] as const;
}

const [PlayerCtx, usePlayerCtx] = createRequiredContext<Ctx>("usePlayer");
const [PlayerControlsCtx, usePlayerControlsCtx] =
  createRequiredContext<PlayerControls>("usePlayerControls");
const [PlayerPlayCtx, usePlayTrackCtx] =
  createRequiredContext<PlayerControls["play"]>("usePlayTrack");
const [PlayerTimeCtx, usePlayerTimeCtx] =
  createRequiredContext<TimeState>("usePlayerTime");
const [PlayerCurrentCtx, useCurrentTrackCtx] =
  createRequiredContext<PlayerState["current"]>("useCurrentTrack");
const [PlayerIsPlayingCtx, useIsPlayingCtx] =
  createRequiredContext<boolean>("useIsPlaying");
const [PlayerQueueCtx, usePlayerQueueCtx] =
  createRequiredContext<PlayerQueueState>("usePlayerQueue");
const [PlayerPlaybackCtx, usePlayerPlaybackCtx] =
  createRequiredContext<PlayerPlaybackState>("usePlayerPlayback");
const [PlayerVolumeCtx, usePlayerVolumeCtx] =
  createRequiredContext<PlayerVolumeState>("usePlayerVolume");
const [RemotePlaybackCtx, useRemotePlaybackCtx] =
  createRequiredContext<RemotePlaybackContextValue>("useRemotePlayback");

export const usePlayer = usePlayerCtx;
export const usePlayerControls = usePlayerControlsCtx;
export const usePlayTrack = usePlayTrackCtx;
export const usePlayerTime = usePlayerTimeCtx;
export const useCurrentTrack = useCurrentTrackCtx;
export const useIsPlaying = useIsPlayingCtx;
export const usePlayerQueue = usePlayerQueueCtx;
export const usePlayerPlayback = usePlayerPlaybackCtx;
export const usePlayerVolume = usePlayerVolumeCtx;
export const useRemotePlayback = useRemotePlaybackCtx;

const LOCK_SCREEN_OPTIONS: AudioLockScreenOptions = {};

function buildNowPlayingMetadata(
  track: PlayerState["current"],
): AudioMetadata | null {
  if (!track) return null;
  return {
    title: track.title,
    artist: track.artist,
    albumTitle: track.album_title,
    artworkUrl: trackCoverUrl(track, 1024),
  };
}

function canPlayLocally(track: TrackListItem): boolean {
  if (isTrackPlayableOffline(track.id)) return true;
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  Alert.alert("Not available offline", "Download it to play while offline.");
  return false;
}

/**
 * Mobile `PlayerProvider`. Same role as the web version but backed by
 * `expo-audio` and `AsyncStorage` via the shared `usePlayerCore` hook.
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const adapter = useExpoAudioAdapter();
  const [appState, setAppState] = useState(() => AppState.currentState);
  const { state, controls, time } = usePlayerCore({
    adapter,
    storage: asyncStorageAdapter,
    interpolateProgress: appState === "active",
    // Play the offline copy when a track has been downloaded; otherwise stream.
    resolveTrackUri: downloadStore.uriFor,
    // Offline (or forced offline): only downloaded tracks may start, and
    // next/prev/auto-advance skip over everything else.
    isTrackPlayable: isTrackPlayableOffline,
  });
  usePlaybackActivityPublisher({
    state,
    time,
    storage: asyncStorageAdapter,
    deviceName: Platform.OS === "ios" ? (Platform.isPad ? "iPad" : "iPhone") : "Mobile",
    adapter,
    controls,
    controlEnabled: true,
  });
  const remoteSession = usePlaybackRemoteSession();
  const [targetDeviceId, setTargetDeviceId] = useState<string | null>(null);
  const [targetDeviceSnapshot, setTargetDeviceSnapshot] =
    useState<PlaybackDevice | null>(null);
  const remoteDevices = useMemo(
    () => filterRemoteDevices(remoteSession.devices, remoteSession.deviceId),
    [remoteSession.deviceId, remoteSession.devices],
  );
  const liveTargetDevice = useMemo(
    () =>
      remoteDevices.find((device) => device.deviceId === targetDeviceId) ??
      null,
    [remoteDevices, targetDeviceId],
  );
  // Fall back to the last known snapshot: a device that briefly drops out of
  // the presence list should not eject the user from the cast session.
  const targetDevice =
    liveTargetDevice ??
    (targetDeviceSnapshot?.deviceId === targetDeviceId
      ? targetDeviceSnapshot
      : null);
  const {
    controlled,
    commandPending,
    lastCommandResult,
    sendCommand,
    seedControlled,
  } = useRemotePlaybackCommands({
    targetDeviceId,
    sourceDeviceId: remoteSession.deviceId,
    targetActivity: targetDevice?.activity,
    targetQueue: targetDevice?.queue,
    initialState: {
      volume: state.volume,
      muted: state.muted,
      shuffle: state.shuffle,
      repeat: state.repeat,
    },
  });

  useEffect(() => {
    if (liveTargetDevice) setTargetDeviceSnapshot(liveTargetDevice);
  }, [liveTargetDevice]);

  // Destructured so this callback's identity tracks only the fields it reads.
  // Depending on `state` wholesale would also rebuild it on every queue change,
  // and it is handed to consumers through the remote-playback context.
  const { isPlaying, muted, repeat, shuffle, volume } = state;
  const selectTarget = useCallback(
    (nextDeviceId: string | null) => {
      if (nextDeviceId && isPlaying) controls.pause();
      const nextDevice =
        remoteDevices.find((device) => device.deviceId === nextDeviceId) ??
        null;
      setTargetDeviceId(nextDeviceId);
      setTargetDeviceSnapshot(nextDevice);
      seedControlled(
        controlledStateForDevice(nextDevice, {
          volume,
          muted,
          shuffle,
          repeat,
        }),
      );
    },
    [
      controls,
      isPlaying,
      muted,
      remoteDevices,
      repeat,
      seedControlled,
      shuffle,
      volume,
    ],
  );

  const lockScreenActiveRef = useRef(false);
  const nowPlayingMetadata = useMemo(
    () => buildNowPlayingMetadata(state.current),
    [state.current],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => {
      subscription.remove();
    };
  }, []);

  // Configure the app as a background-capable music player up front. Toggling
  // this from React state can race with the device moving to the lock screen.
  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "doNotMix",
    }).catch(() => {
      /* ignored - audio mode is best-effort on first run */
    });
  }, []);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (!isLockScreenControlsAvailable()) return;

    const subscription = addLockScreenCommandListener((event) => {
      if (event.action === "next") controls.next();
      if (event.action === "previous") controls.prev();
    });

    return () => {
      subscription.remove();
    };
  }, [controls.next, controls.prev]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;

    return () => {
      setLockScreenTrackControlsEnabled(false);
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== "ios") return;

    // Keep the session while a local track is loaded, including pause.
    // Gating on isPlaying || appState === "active" deleted MPNowPlayingInfo
    // the moment the user paused from Control Center / the lock screen, or
    // iOS paused for a route loss (AirPod pulled). The OS then had nothing
    // to resume.
    const shouldExposeLockScreen = shouldExposeNowPlayingSession({
      hasTrack: nowPlayingMetadata !== null,
      isCasting: !!targetDevice,
    });

    if (!shouldExposeLockScreen || nowPlayingMetadata === null) {
      setLockScreenTrackControlsEnabled(false);
      if (lockScreenActiveRef.current) {
        adapter.clearLockScreenControls();
        lockScreenActiveRef.current = false;
      }
      return;
    }

    if (!lockScreenActiveRef.current) {
      setLockScreenTrackControlsEnabled(true);
      adapter.setActiveForLockScreen(
        true,
        nowPlayingMetadata,
        LOCK_SCREEN_OPTIONS,
      );
      lockScreenActiveRef.current = true;
      return;
    }

    setLockScreenTrackControlsEnabled(true);
    adapter.updateLockScreenMetadata(nowPlayingMetadata);
    // isPlaying stays in the deps so pause/resume refresh playbackRate.
  }, [adapter, nowPlayingMetadata, state.isPlaying, targetDevice]);

  const displayedState = useMemo<PlayerState>(
    () => targetDevice ? remotePlayerState(targetDevice, controlled) : state,
    [targetDevice, controlled, state],
  );
  const routedControls = useRoutedPlayerControls({
    controls,
    targetDevice,
    controlled,
    sendCommand,
    remoteQueue: displayedState.queue,
    canPlayLocally,
  });
  const routedPlay = routedControls.play;
  // Ticking, not memoized from the heartbeat: snapshots arrive every ~10s,
  // and a memo keyed on them made cast-mode lyrics/scrubber time advance in
  // ten-second leaps. Foreground-gated like `interpolateProgress` above.
  const remoteTime = useRemoteActivityClock(
    targetDevice?.activity,
    appState === "active",
  );
  const displayedTime = targetDevice ? remoteTime : time;
  const value = useMemo<Ctx>(
    () => ({ ...displayedState, ...routedControls }),
    [displayedState, routedControls],
  );
  const queueValue = useMemo<PlayerQueueState>(
    () => ({ queue: displayedState.queue, index: displayedState.index }),
    [displayedState.queue, displayedState.index],
  );
  const playbackValue = useMemo<PlayerPlaybackState>(
    () => ({
      isPlaying: displayedState.isPlaying,
      shuffle: displayedState.shuffle,
      repeat: displayedState.repeat,
    }),
    [displayedState.isPlaying, displayedState.shuffle, displayedState.repeat],
  );
  const volumeValue = useMemo<PlayerVolumeState>(
    () => ({ volume: displayedState.volume, muted: displayedState.muted }),
    [displayedState.volume, displayedState.muted],
  );
  const remoteValue = useMemo<RemotePlaybackContextValue>(
    () => ({
      deviceId: remoteSession.deviceId,
      connected: remoteSession.connected,
      remoteDevices,
      targetDeviceId,
      targetDevice,
      commandPending,
      lastCommandResult,
      selectTarget,
    }),
    [
      lastCommandResult,
      commandPending,
      remoteDevices,
      remoteSession.connected,
      remoteSession.deviceId,
      selectTarget,
      targetDevice,
      targetDeviceId,
    ],
  );

  return (
    <RemotePlaybackCtx.Provider value={remoteValue}>
    <PlayerCurrentCtx.Provider value={displayedState.current}>
      <PlayerIsPlayingCtx.Provider value={displayedState.isPlaying}>
        <PlayerQueueCtx.Provider value={queueValue}>
          <PlayerPlaybackCtx.Provider value={playbackValue}>
            <PlayerVolumeCtx.Provider value={volumeValue}>
              <PlayerPlayCtx.Provider value={routedControls.play}>
                <PlayerControlsCtx.Provider value={routedControls}>
                  <PlayerCtx.Provider value={value}>
                    <PlayerTimeCtx.Provider value={displayedTime}>
                      {children}
                    </PlayerTimeCtx.Provider>
                  </PlayerCtx.Provider>
                </PlayerControlsCtx.Provider>
              </PlayerPlayCtx.Provider>
            </PlayerVolumeCtx.Provider>
          </PlayerPlaybackCtx.Provider>
        </PlayerQueueCtx.Provider>
      </PlayerIsPlayingCtx.Provider>
    </PlayerCurrentCtx.Provider>
    </RemotePlaybackCtx.Provider>
  );
}
