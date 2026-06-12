import {
  createContext,
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
import { AppState, Platform } from "react-native";
import {
  trackCoverUrl,
  usePlayerCore,
  type PlayerControls,
  type PlayerState,
  type TimeState,
} from "@music-library/core";
import { useExpoAudioAdapter } from "../adapters/expo-audio-adapter";
import { asyncStorageAdapter } from "../adapters/async-storage-adapter";
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

export const usePlayer = usePlayerCtx;
export const usePlayerControls = usePlayerControlsCtx;
export const usePlayTrack = usePlayTrackCtx;
export const usePlayerTime = usePlayerTimeCtx;
export const useCurrentTrack = useCurrentTrackCtx;
export const useIsPlaying = useIsPlayingCtx;
export const usePlayerQueue = usePlayerQueueCtx;
export const usePlayerPlayback = usePlayerPlaybackCtx;
export const usePlayerVolume = usePlayerVolumeCtx;

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
  });
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

    const shouldExposeLockScreen =
      !!nowPlayingMetadata &&
      (state.isPlaying || appState === "active");

    if (!shouldExposeLockScreen) {
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
  }, [adapter, appState, nowPlayingMetadata, state.isPlaying]);

  const value = useMemo<Ctx>(
    () => ({ ...state, ...controls }),
    [state, controls],
  );
  const queueValue = useMemo<PlayerQueueState>(
    () => ({ queue: state.queue, index: state.index }),
    [state.queue, state.index],
  );
  const playbackValue = useMemo<PlayerPlaybackState>(
    () => ({
      isPlaying: state.isPlaying,
      shuffle: state.shuffle,
      repeat: state.repeat,
    }),
    [state.isPlaying, state.shuffle, state.repeat],
  );
  const volumeValue = useMemo<PlayerVolumeState>(
    () => ({ volume: state.volume, muted: state.muted }),
    [state.volume, state.muted],
  );

  return (
    <PlayerCurrentCtx.Provider value={state.current}>
      <PlayerIsPlayingCtx.Provider value={state.isPlaying}>
        <PlayerQueueCtx.Provider value={queueValue}>
          <PlayerPlaybackCtx.Provider value={playbackValue}>
            <PlayerVolumeCtx.Provider value={volumeValue}>
              <PlayerPlayCtx.Provider value={controls.play}>
                <PlayerControlsCtx.Provider value={controls}>
                  <PlayerCtx.Provider value={value}>
                    <PlayerTimeCtx.Provider value={time}>
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
  );
}

