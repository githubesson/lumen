import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  setAudioModeAsync,
  type AudioLockScreenOptions,
} from "expo-audio";
import { Alert, AppState, Platform } from "react-native";
import * as Haptics from "expo-haptics";
import {
  buildNowPlayingMetadata,
  queueProgress,
  shouldExposeNowPlayingSession,
  usePlaybackActivityPublisher,
  usePlayerCore,
  useRemotePlaybackController,
  type PlayerControls,
  type PlayerState,
  type QueueProgress,
  type RemotePlaybackContextValue,
  type TrackListItem,
  type TimeState,
} from "@music-library/core";
import { useExpoAudioAdapter } from "../adapters/expo-audio-adapter";
import { asyncStorageAdapter } from "../adapters/async-storage-adapter";
import { LOCAL_DEVICE_NAME } from "../lib/device-name";
import { downloadStore } from "../lib/downloads";
import { isTrackPlayableOffline } from "../lib/offline-mode";
import { recordCrashBreadcrumb } from "../lib/crash-reporting";
import { recordPlaybackDiagnostic } from "../lib/diagnostics/playback";
import { useSmoothMix } from "../lib/smooth-mix";
import {
  addLockScreenCommandListener,
  isLockScreenControlsAvailable,
  setLockScreenTrackControlsEnabled,
} from "../modules/lock-screen-controls";

type PlayerQueueState = Pick<PlayerState, "queue" | "index"> & {
  /** Absolute position and counts, beyond a remote device's queue window. */
  progress: QueueProgress;
};
type PlayerPlaybackState = Pick<
  PlayerState,
  "isPlaying" | "shuffle" | "repeat"
>;
type PlayerVolumeState = Pick<PlayerState, "volume" | "muted">;

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

const [PlayerControlsCtx, usePlayerControlsCtx] =
  createRequiredContext<PlayerControls>("usePlayerControls");
const [PlayerPlayCtx, usePlayTrackCtx] =
  createRequiredContext<PlayerControls["play"]>("usePlayTrack");
// Its own slice, like play: swipeable rows hold it, and it only changes when
// a remote target comes or goes.
const [PlayerPlayNextCtx, usePlayNextCtx] =
  createRequiredContext<PlayerControls["playNext"]>("usePlayNext");
const [PlayerTimeCtx, usePlayerTimeCtx] =
  createRequiredContext<TimeState>("usePlayerTime");
const [PlayerCurrentCtx, useCurrentTrackCtx] =
  createRequiredContext<PlayerState["current"]>("useCurrentTrack");
// Layout that only cares whether anything is loaded (the dock inset on every
// list screen) reads this, so it doesn't re-render on each track change.
const [PlayerHasTrackCtx, useHasCurrentTrackCtx] =
  createRequiredContext<boolean>("useHasCurrentTrack");
const [PlayerIsPlayingCtx, useIsPlayingCtx] =
  createRequiredContext<boolean>("useIsPlaying");
const [PlayerErrorCtx, usePlaybackErrorCtx] =
  createRequiredContext<PlayerState["playbackError"]>("usePlaybackErrorMessage");
const [PlayerQueueCtx, usePlayerQueueCtx] =
  createRequiredContext<PlayerQueueState>("usePlayerQueue");
const [PlayerPlaybackCtx, usePlayerPlaybackCtx] =
  createRequiredContext<PlayerPlaybackState>("usePlayerPlayback");
const [PlayerVolumeCtx, usePlayerVolumeCtx] =
  createRequiredContext<PlayerVolumeState>("usePlayerVolume");
const [RemotePlaybackCtx, useRemotePlaybackCtx] =
  createRequiredContext<RemotePlaybackContextValue>("useRemotePlayback");

export const usePlayerControls = usePlayerControlsCtx;
export const usePlayTrack = usePlayTrackCtx;
export const usePlayNext = usePlayNextCtx;
export const usePlayerTime = usePlayerTimeCtx;
export const useCurrentTrack = useCurrentTrackCtx;
export const useHasCurrentTrack = useHasCurrentTrackCtx;
export const useIsPlaying = useIsPlayingCtx;
export const usePlayerQueue = usePlayerQueueCtx;
export const usePlayerPlayback = usePlayerPlaybackCtx;
export const usePlayerVolume = usePlayerVolumeCtx;
export const useRemotePlayback = useRemotePlaybackCtx;

/** Why `track` stopped playing, if it's the current track and failed. */
export function usePlaybackErrorMessage(track: TrackListItem | null): string | null {
  const error = usePlaybackErrorCtx();
  return track && error?.trackId === track.id ? error.message : null;
}

const LOCK_SCREEN_OPTIONS: AudioLockScreenOptions = {};

// A module value rather than context, so list buttons can read it when
// pressed without every screen re-rendering on each remote update.
let playingRemotely = false;

/** Whether play commands go to another device right now. */
export function isPlayingRemotely(): boolean {
  return playingRemotely;
}

// What Play Next depends on, as module state too: every swipeable row asks,
// and only the rows whose answer changes should re-render (the old and new
// current track), not every row on every track change.
let playNextScope = { remote: false, currentId: null as string | null };
const playNextScopeListeners = new Set<() => void>();

function setPlayNextScope(remote: boolean, currentId: string | null) {
  if (playNextScope.remote === remote && playNextScope.currentId === currentId) return;
  playNextScope = { remote, currentId };
  for (const listener of playNextScopeListeners) listener();
}

function subscribePlayNextScope(listener: () => void) {
  playNextScopeListeners.add(listener);
  return () => {
    playNextScopeListeners.delete(listener);
  };
}

/**
 * Whether Play Next applies to `trackId` here: not while controlling another
 * device (no device takes a queue insert yet), and not for the track that's
 * playing. Rows also leave it out for tracks that can't play.
 */
export function useCanPlayNext(trackId: string): boolean {
  return useSyncExternalStore(
    subscribePlayNextScope,
    () => !playNextScope.remote && playNextScope.currentId !== trackId,
  );
}

function canPlayLocally(track: TrackListItem): boolean {
  if (isTrackPlayableOffline(track.id)) return true;
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  Alert.alert("Not available offline", "Download it to play while offline.");
  return false;
}

/**
 * Mobile `PlayerProvider`. Same role as the web version but backed by
 * `expo-audio` and `AsyncStorage` via the shared `usePlayerCore` hook, with
 * remote playback from the shared `useRemotePlaybackController`.
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const adapter = useExpoAudioAdapter();
  const [appState, setAppState] = useState(() => AppState.currentState);
  const crossfadeSeconds = useSmoothMix();
  const { state, controls, time } = usePlayerCore({
    adapter,
    storage: asyncStorageAdapter,
    interpolateProgress: appState === "active",
    // Play the offline copy when a track has been downloaded; otherwise stream.
    resolveTrackUri: downloadStore.uriFor,
    // Offline (or forced offline): only downloaded tracks may start, and
    // next/prev/auto-advance skip over everything else.
    isTrackPlayable: isTrackPlayableOffline,
    crossfadeSeconds,
  });
  // Destructured so hooks below depend only on the fields they read. Depending
  // on `state` wholesale would rebuild them on every queue change.
  const { current, index, isPlaying, repeat, shuffle } = state;
  const queueLength = state.queue.length;
  const currentId = current?.id;
  useEffect(() => {
    recordPlaybackDiagnostic("audio-core-state", {
      isPlaying,
      queueIndex: index,
      queueLength,
      repeat,
      currentPlayable: currentId ? isTrackPlayableOffline(currentId) : false,
    });
    recordCrashBreadcrumb("playback", {
      isPlaying,
      queueIndex: index,
      queueLength,
      shuffle,
      repeat,
    });
  }, [isPlaying, index, queueLength, shuffle, repeat, currentId]);
  usePlaybackActivityPublisher({
    state,
    time,
    storage: asyncStorageAdapter,
    deviceName: LOCAL_DEVICE_NAME,
    adapter,
    controls,
    controlEnabled: true,
  });
  const {
    displayedState,
    displayedTime,
    controls: routedControls,
    remote,
  } = useRemotePlaybackController({
    state,
    controls,
    time,
    // Foreground-gated like `interpolateProgress` above.
    clockEnabled: appState === "active",
    canPlayLocally,
  });
  const { targetDevice } = remote;
  const remoteTarget = targetDevice != null;
  useEffect(() => {
    playingRemotely = remoteTarget;
    return () => {
      playingRemotely = false;
    };
  }, [remoteTarget]);
  useEffect(() => {
    setPlayNextScope(remoteTarget, currentId ?? null);
  }, [remoteTarget, currentId]);
  useEffect(
    () => () => {
      setPlayNextScope(false, null);
    },
    [],
  );

  const lockScreenActiveRef = useRef(false);
  const nowPlayingMetadata = useMemo(
    () => buildNowPlayingMetadata(current),
    [current],
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

  const { next: playNext, prev: playPrev } = controls;
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (!isLockScreenControlsAvailable()) return;

    const subscription = addLockScreenCommandListener((event) => {
      if (event.action === "next") playNext();
      if (event.action === "previous") playPrev();
    });

    return () => {
      subscription.remove();
    };
  }, [playNext, playPrev]);

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
  }, [adapter, nowPlayingMetadata, isPlaying, targetDevice]);

  const { queue: displayedQueue, index: displayedIndex } = displayedState;
  const queueOffset = targetDevice?.queue?.offset;
  const queueTotal = targetDevice?.queue?.total;
  const queueValue = useMemo<PlayerQueueState>(() => {
    const window =
      queueOffset === undefined || queueTotal === undefined
        ? null
        : { offset: queueOffset, total: queueTotal };
    return {
      queue: displayedQueue,
      index: displayedIndex,
      progress: queueProgress({ queue: displayedQueue, index: displayedIndex }, window),
    };
  }, [displayedIndex, displayedQueue, queueOffset, queueTotal]);
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
  return (
    <RemotePlaybackCtx.Provider value={remote}>
      <PlayerCurrentCtx.Provider value={displayedState.current}>
        <PlayerHasTrackCtx.Provider value={displayedState.current !== null}>
          <PlayerIsPlayingCtx.Provider value={displayedState.isPlaying}>
            <PlayerQueueCtx.Provider value={queueValue}>
              <PlayerPlaybackCtx.Provider value={playbackValue}>
                <PlayerVolumeCtx.Provider value={volumeValue}>
                  <PlayerPlayCtx.Provider value={routedControls.play}>
                    <PlayerPlayNextCtx.Provider value={routedControls.playNext}>
                      <PlayerControlsCtx.Provider value={routedControls}>
                        <PlayerTimeCtx.Provider value={displayedTime}>
                          <PlayerErrorCtx.Provider value={displayedState.playbackError}>
                            {children}
                          </PlayerErrorCtx.Provider>
                        </PlayerTimeCtx.Provider>
                      </PlayerControlsCtx.Provider>
                    </PlayerPlayNextCtx.Provider>
                  </PlayerPlayCtx.Provider>
                </PlayerVolumeCtx.Provider>
              </PlayerPlaybackCtx.Provider>
            </PlayerQueueCtx.Provider>
          </PlayerIsPlayingCtx.Provider>
        </PlayerHasTrackCtx.Provider>
      </PlayerCurrentCtx.Provider>
    </RemotePlaybackCtx.Provider>
  );
}
