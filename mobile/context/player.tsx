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
import { AppState, Platform } from "react-native";
import {
  sendRemotePlaybackCommand,
  trackCoverUrl,
  usePlaybackActivityPublisher,
  usePlaybackRemoteSession,
  usePlayerCore,
  type PlaybackDevice,
  type PlayerControls,
  type PlayerState,
  type RemotePlaybackCommandAction,
  type RemotePlaybackCommandResult,
  type TrackListItem,
  type TimeState,
} from "@music-library/core";
import { useExpoAudioAdapter } from "../adapters/expo-audio-adapter";
import { asyncStorageAdapter } from "../adapters/async-storage-adapter";
import { downloadStore } from "../lib/downloads";
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
  });
  usePlaybackActivityPublisher({
    state,
    time,
    storage: asyncStorageAdapter,
    deviceName: Platform.OS === "ios" ? "iPhone" : "Mobile",
    adapter,
    controls,
    controlEnabled: true,
  });
  const remoteSession = usePlaybackRemoteSession();
  const [targetDeviceId, setTargetDeviceId] = useState<string | null>(null);
  const [pendingCommandCount, setPendingCommandCount] = useState(0);
  const [lastCommandResult, setLastCommandResult] =
    useState<RemotePlaybackCommandResult | null>(null);
  const [controlledState, setControlledState] = useState(() => ({
    volume: state.volume,
    muted: state.muted,
    shuffle: state.shuffle,
    repeat: state.repeat,
  }));
  const [controlledQueue, setControlledQueue] = useState<TrackListItem[]>([]);
  const remoteDevices = useMemo(
    () =>
      remoteSession.devices.filter(
        (device) =>
          device.deviceId !== remoteSession.deviceId &&
          device.online &&
          device.controlEnabled,
      ),
    [remoteSession.deviceId, remoteSession.devices],
  );
  const targetDevice = useMemo(
    () =>
      remoteDevices.find((device) => device.deviceId === targetDeviceId) ??
      null,
    [remoteDevices, targetDeviceId],
  );
  const remoteCurrent = useMemo(
    () => activityTrack(targetDevice?.activity ?? null),
    [targetDevice?.activity],
  );

  useEffect(() => {
    if (targetDeviceId && remoteSession.connected && !targetDevice) {
      setTargetDeviceId(null);
      setControlledQueue([]);
    }
  }, [remoteSession.connected, targetDevice, targetDeviceId]);

  useEffect(() => {
    if (!targetDevice) return;
    if (!remoteCurrent) {
      setControlledQueue([]);
      return;
    }
    setControlledQueue((queue) =>
      queue.some((track) => track.id === remoteCurrent.id)
        ? queue
        : [remoteCurrent],
    );
  }, [remoteCurrent, targetDevice]);

  const selectTarget = useCallback(
    (nextDeviceId: string | null) => {
      if (nextDeviceId && state.isPlaying) controls.pause();
      setTargetDeviceId(nextDeviceId);
      setLastCommandResult(null);
      setControlledState({
        volume: state.volume,
        muted: state.muted,
        shuffle: state.shuffle,
        repeat: state.repeat,
      });
      const nextActivity = remoteDevices.find(
        (device) => device.deviceId === nextDeviceId,
      )?.activity;
      const nextTrack = activityTrack(nextActivity ?? null);
      setControlledQueue(nextTrack ? [nextTrack] : []);
    },
    [
      controls,
      remoteDevices,
      state.isPlaying,
      state.muted,
      state.repeat,
      state.shuffle,
      state.volume,
    ],
  );

  const sendCommand = useCallback(
    async (
      action: RemotePlaybackCommandAction,
      args: Record<string, unknown> = {},
    ): Promise<RemotePlaybackCommandResult> => {
      if (!targetDeviceId) {
        const result: RemotePlaybackCommandResult = {
          commandId: "",
          sourceDeviceId: remoteSession.deviceId ?? "",
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
          setControlledState((current) =>
            optimisticControlledState(current, action, args),
          );
        }
        setLastCommandResult(result);
        return result;
      } finally {
        setPendingCommandCount((count) => Math.max(0, count - 1));
      }
    },
    [remoteSession.deviceId, targetDeviceId],
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

    const shouldExposeLockScreen =
      !targetDevice &&
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
  }, [adapter, appState, nowPlayingMetadata, state.isPlaying, targetDevice]);

  const routedPlay = useCallback<PlayerControls["play"]>(
    (track, queue) => {
      if (!targetDevice) {
        controls.play(track, queue);
        return;
      }
      const remoteQueue = buildRemoteQueue(track, queue);
      void sendCommand("play_track", {
        track: compactRemoteTrack(track),
        queue: remoteQueue.map(compactRemoteTrack),
      }).then((result) => {
        if (result.status === "applied") setControlledQueue(remoteQueue);
      });
    },
    [controls, sendCommand, targetDevice],
  );
  const controlledIndex = remoteCurrent
    ? Math.max(
        0,
        controlledQueue.findIndex((track) => track.id === remoteCurrent.id),
      )
    : 0;
  const routedControls = useMemo<PlayerControls>(
    () => ({
      play: routedPlay,
      resume: () => {
        if (targetDevice) void sendCommand("set_playing", { playing: true });
        else controls.resume();
      },
      pause: () => {
        if (targetDevice) void sendCommand("set_playing", { playing: false });
        else controls.pause();
      },
      toggle: () => {
        if (targetDevice) {
          void sendCommand("set_playing", {
            playing: !targetDevice.activity?.is_playing,
          });
        } else controls.toggle();
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
        if (!targetDevice) {
          controls.jumpTo(index);
          return;
        }
        const track = controlledQueue[index];
        if (track) routedPlay(track, controlledQueue);
      },
      seek: (seconds) => {
        if (targetDevice) void sendCommand("seek", { position_sec: seconds });
        else controls.seek(seconds);
      },
      setVolume: (volume) => {
        if (targetDevice) void sendCommand("set_volume", { volume });
        else controls.setVolume(volume);
      },
      setMuted: (muted) => {
        if (targetDevice) void sendCommand("set_muted", { muted });
        else controls.setMuted(muted);
      },
      toggleMute: () => {
        if (targetDevice) {
          void sendCommand("set_muted", { muted: !controlledState.muted });
        } else controls.toggleMute();
      },
      setShuffle: (shuffle) => {
        if (targetDevice) void sendCommand("set_shuffle", { shuffle });
        else controls.setShuffle(shuffle);
      },
      toggleShuffle: () => {
        if (targetDevice) {
          void sendCommand("set_shuffle", {
            shuffle: !controlledState.shuffle,
          });
        } else controls.toggleShuffle();
      },
      setRepeat: (repeat) => {
        if (targetDevice) void sendCommand("set_repeat", { repeat });
        else controls.setRepeat(repeat);
      },
      cycleRepeat: () => {
        if (targetDevice) {
          void sendCommand("set_repeat", {
            repeat: nextRepeat(controlledState.repeat),
          });
        } else controls.cycleRepeat();
      },
    }),
    [
      controlledQueue,
      controlledState.muted,
      controlledState.repeat,
      controlledState.shuffle,
      controls,
      routedPlay,
      sendCommand,
      targetDevice,
    ],
  );
  const displayedState = useMemo<PlayerState>(
    () =>
      targetDevice
        ? {
            current: remoteCurrent,
            queue: controlledQueue,
            index: controlledIndex,
            isPlaying: !!targetDevice.activity?.is_playing,
            volume: controlledState.volume,
            muted: controlledState.muted,
            shuffle: controlledState.shuffle,
            repeat: controlledState.repeat,
          }
        : state,
    [
      controlledIndex,
      controlledQueue,
      controlledState,
      remoteCurrent,
      state,
      targetDevice,
    ],
  );
  const displayedTime = useMemo<TimeState>(
    () =>
      targetDevice
        ? activityTime(targetDevice.activity)
        : time,
    [targetDevice, time],
  );
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
      commandPending: pendingCommandCount > 0,
      lastCommandResult,
      selectTarget,
    }),
    [
      lastCommandResult,
      pendingCommandCount,
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

function activityTrack(
  activity: PlaybackDevice["activity"],
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

function activityTime(activity: PlaybackDevice["activity"]): TimeState {
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

function nextRepeat(repeat: PlayerState["repeat"]): PlayerState["repeat"] {
  return repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
}

function optimisticControlledState(
  state: {
    volume: number;
    muted: boolean;
    shuffle: boolean;
    repeat: PlayerState["repeat"];
  },
  action: RemotePlaybackCommandAction,
  args: Record<string, unknown>,
): {
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: PlayerState["repeat"];
} {
  switch (action) {
    case "set_volume":
      return typeof args.volume === "number"
        ? { ...state, volume: Math.max(0, Math.min(1, args.volume)) }
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
        ? { ...state, repeat: args.repeat as PlayerState["repeat"] }
        : state;
    default:
      return state;
  }
}

function buildRemoteQueue(
  track: TrackListItem,
  queue?: TrackListItem[],
): TrackListItem[] {
  const source = queue?.length ? queue : [track];
  const selectedIndex = Math.max(
    0,
    source.findIndex((item) => item.id === track.id),
  );
  const start = Math.max(
    0,
    Math.min(selectedIndex - 24, source.length - 50),
  );
  const window = source.slice(start, start + 50);
  return window.some((item) => item.id === track.id) ? window : [track];
}

function compactRemoteTrack(track: TrackListItem): TrackListItem {
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
