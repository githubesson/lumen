import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  asyncifySyncStorage,
  sendRemotePlaybackCommand,
  usePlaybackActivityPublisher,
  usePlaybackRemoteSession,
  usePlayerCore,
  type AudioAdapter,
  type PlaybackDevice,
  type PlayerControls,
  type PlayerState,
  type RemotePlaybackCommandAction,
  type RemotePlaybackCommandResult,
  type TrackListItem,
  type TimeState,
} from "@music-library/core";
import { useHtmlAudioAdapter } from "../adapters/html-audio-adapter";
import { AudioOutputProvider } from "../lib/audioOutput";
import { useKey } from "../lib/keybindings";
import { isElectron } from "../lib/platform";

type Ctx = PlayerState & PlayerControls;
type RemotePlaybackCtxValue = {
  deviceId: string | null;
  connected: boolean;
  devices: PlaybackDevice[];
  remoteDevices: PlaybackDevice[];
  targetDeviceId: string | null;
  targetDevice: PlaybackDevice | null;
  controlledVolume: number;
  controlledMuted: boolean;
  controlledShuffle: boolean;
  controlledRepeat: PlayerState["repeat"];
  commandPending: boolean;
  lastCommandResult: RemotePlaybackCommandResult | null;
  selectTarget: (deviceId: string | null) => void;
  sendCommand: (
    action: RemotePlaybackCommandAction,
    args?: Record<string, unknown>,
  ) => Promise<RemotePlaybackCommandResult>;
};

const PlayerCtx = createContext<Ctx | null>(null);
const PlayerTimeCtx = createContext<TimeState | null>(null);
const RemotePlaybackCtx = createContext<RemotePlaybackCtxValue | null>(null);
// Exposed so platform-integration hooks (Discord RPC, etc.) can subscribe to
// raw audio events without waiting for React state to round-trip through
// rAF smoothing — e.g. responding to a seek the same frame it lands.
const PlayerAdapterCtx = createContext<AudioAdapter | null>(null);

// Wrap the browser's sync localStorage in the shared async KV interface.
const webStorage = asyncifySyncStorage({
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
});

/**
 * Web `PlayerProvider`. Delegates all state (queue, shuffle, repeat, volume,
 * track-change loading, rAF-smoothed currentTime, /play reporting) to the
 * shared `usePlayerCore` hook via an `HTMLAudioElement`-backed adapter.
 * The bits that remain here are all web-only integrations: the Media Session
 * API, global keyboard shortcuts, and rendering the `<audio>` element the
 * adapter drives.
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const { adapter, audioRefs } = useHtmlAudioAdapter();
  const { state, controls, time } = usePlayerCore({
    adapter,
    storage: webStorage,
  });
  usePlaybackActivityPublisher({
    state,
    time,
    storage: webStorage,
    deviceName: isElectron() ? "Desktop" : "Web",
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

  useEffect(() => {
    if (targetDeviceId && remoteSession.connected && !targetDevice) {
      setTargetDeviceId(null);
    }
  }, [remoteSession.connected, targetDevice, targetDeviceId]);

  useEffect(() => {
    const activity = targetDevice?.activity;
    if (!activity) return;
    setControlledState((current) => ({
      ...current,
      volume:
        typeof activity.volume === "number"
          ? Math.max(0, Math.min(1, activity.volume))
          : current.volume,
      muted:
        typeof activity.muted === "boolean" ? activity.muted : current.muted,
    }));
  }, [targetDevice?.activity?.muted, targetDevice?.activity?.volume]);

  const selectTarget = useCallback((nextDeviceId: string | null) => {
    if (nextDeviceId && state.isPlaying) controls.pause();
    setTargetDeviceId(nextDeviceId);
    setLastCommandResult(null);
    const nextActivity = remoteDevices.find(
      (device) => device.deviceId === nextDeviceId,
    )?.activity;
    setControlledState({
      volume:
        typeof nextActivity?.volume === "number"
          ? Math.max(0, Math.min(1, nextActivity.volume))
          : state.volume,
      muted:
        typeof nextActivity?.muted === "boolean"
          ? nextActivity.muted
          : state.muted,
      shuffle: state.shuffle,
      repeat: state.repeat,
    });
  }, [controls, remoteDevices, state.isPlaying, state.muted, state.repeat, state.shuffle, state.volume]);

  const sendCommand = useCallback<RemotePlaybackCtxValue["sendCommand"]>(
    async (action, args = {}) => {
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

  // Media Session API — surface in OS media controls / Bluetooth buttons.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    // Handlers registered for a previous track must not outlive it: an OS or
    // Bluetooth media button pressed after the queue empties would otherwise
    // fire a callback closed over stale `controls`.
    const clear = () => {
      navigator.mediaSession.metadata = null;
      for (const action of [
        "play",
        "pause",
        "previoustrack",
        "nexttrack",
        "seekto",
      ] as const) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    };
    if (!state.current) {
      clear();
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.current.title,
      artist: state.current.artist ?? "",
      album: state.current.album_title ?? "",
    });
    // Discrete play/pause (previously both fired the same toggle, so the OS
    // "play" button could pause an already-playing track and vice versa).
    navigator.mediaSession.setActionHandler("play", () => {
      if (!state.isPlaying) controls.toggle();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      if (state.isPlaying) controls.toggle();
    });
    navigator.mediaSession.setActionHandler("previoustrack", controls.prev);
    navigator.mediaSession.setActionHandler("nexttrack", controls.next);
    navigator.mediaSession.setActionHandler("seekto", (e) => {
      if (typeof e.seekTime === "number") controls.seek(e.seekTime);
    });
    return clear;
  }, [
    state.current,
    state.isPlaying,
    controls.toggle,
    controls.prev,
    controls.next,
    controls.seek,
  ]);

  // Keyboard shortcuts (spec §5) — routed through the central registry.
  useKey(
    "space",
    (e) => {
      e.preventDefault();
      if (targetDevice) {
        void sendCommand("set_playing", {
          playing: !targetDevice.activity?.is_playing,
        });
      } else {
        controls.toggle();
      }
    },
    { id: "player:toggle", label: "Play / pause", group: "Playback" },
  );
  useKey(
    "left",
    () => {
      if (targetDevice) {
        void sendCommand("seek", {
          position_sec: Math.max(
            0,
            remoteActivityPosition(targetDevice.activity) - 5,
          ),
        });
      } else controls.seek(Math.max(0, time.currentTime - 5));
    },
    { id: "player:seek-back", label: "Seek back 5s", group: "Playback" },
  );
  useKey(
    "right",
    () => {
      if (targetDevice) {
        void sendCommand("seek", {
          position_sec: Math.min(
            targetDevice.activity?.duration_sec || Infinity,
            remoteActivityPosition(targetDevice.activity) + 5,
          ),
        });
      } else {
        controls.seek(
          Math.min(time.duration || Infinity, time.currentTime + 5),
        );
      }
    },
    { id: "player:seek-fwd", label: "Seek forward 5s", group: "Playback" },
  );
  useKey(
    "up",
    (e) => {
      e.preventDefault();
      if (targetDevice) {
        void sendCommand("set_volume", {
          volume: Math.min(1, controlledState.volume + 0.05),
        });
      } else controls.setVolume(state.volume + 0.05);
    },
    { id: "player:vol-up", label: "Volume up", group: "Playback" },
  );
  useKey(
    "down",
    (e) => {
      e.preventDefault();
      if (targetDevice) {
        void sendCommand("set_volume", {
          volume: Math.max(0, controlledState.volume - 0.05),
        });
      } else controls.setVolume(state.volume - 0.05);
    },
    { id: "player:vol-down", label: "Volume down", group: "Playback" },
  );
  useKey("n", () => {
    if (targetDevice) void sendCommand("next");
    else controls.next();
  }, {
    id: "player:next",
    label: "Next track",
    group: "Playback",
  });
  useKey("p", () => {
    if (targetDevice) void sendCommand("previous");
    else controls.prev();
  }, {
    id: "player:prev",
    label: "Previous track",
    group: "Playback",
  });
  useKey("m", () => {
    if (targetDevice) {
      void sendCommand("set_muted", { muted: !controlledState.muted });
    }
    else controls.toggleMute();
  }, {
    id: "player:mute",
    label: "Mute / unmute",
    group: "Playback",
  });
  useKey("s", () => {
    if (targetDevice) {
      void sendCommand("set_shuffle", { shuffle: !controlledState.shuffle });
    } else controls.toggleShuffle();
  }, {
    id: "player:shuffle",
    label: "Shuffle",
    group: "Playback",
  });
  useKey("r", () => {
    if (targetDevice) {
      void sendCommand("set_repeat", {
        repeat: nextRepeat(controlledState.repeat),
      });
    } else controls.cycleRepeat();
  }, {
    id: "player:repeat",
    label: "Repeat",
    group: "Playback",
  });

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
      });
    },
    [controls, sendCommand, targetDevice],
  );

  const value = useMemo<Ctx>(
    () => ({ ...state, ...controls, play: routedPlay }),
    [state, controls, routedPlay],
  );
  const remoteValue = useMemo<RemotePlaybackCtxValue>(
    () => ({
      ...remoteSession,
      remoteDevices,
      targetDeviceId,
      targetDevice,
      controlledVolume: controlledState.volume,
      controlledMuted: controlledState.muted,
      controlledShuffle: controlledState.shuffle,
      controlledRepeat: controlledState.repeat,
      commandPending: pendingCommandCount > 0,
      lastCommandResult,
      selectTarget,
      sendCommand,
    }),
    [
      lastCommandResult,
      pendingCommandCount,
      controlledState,
      remoteDevices,
      remoteSession,
      selectTarget,
      sendCommand,
      targetDevice,
      targetDeviceId,
    ],
  );

  return (
    <RemotePlaybackCtx.Provider value={remoteValue}>
      <PlayerCtx.Provider value={value}>
        <PlayerTimeCtx.Provider value={time}>
          <PlayerAdapterCtx.Provider value={adapter}>
            {/* The adapter owns these ref objects and only ever reads them
                from event handlers/effects; handing them to a child provider
                and to `ref` props is not a render-time `.current` read, which
                is what react-hooks/refs is guarding against. */}
            {/* eslint-disable-next-line react-hooks/refs */}
            <AudioOutputProvider audioRefs={audioRefs}>
              {children}
              <audio ref={audioRefs[0]} preload="auto" />
              {/* eslint-disable-next-line react-hooks/refs */}
              <audio ref={audioRefs[1]} preload="auto" />
            </AudioOutputProvider>
          </PlayerAdapterCtx.Provider>
        </PlayerTimeCtx.Provider>
      </PlayerCtx.Provider>
    </RemotePlaybackCtx.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer requires PlayerProvider");
  return ctx;
}

export function usePlayerTime() {
  const ctx = useContext(PlayerTimeCtx);
  if (!ctx) throw new Error("usePlayerTime requires PlayerProvider");
  return ctx;
}

export function useRemotePlayback() {
  const ctx = useContext(RemotePlaybackCtx);
  if (!ctx) throw new Error("useRemotePlayback requires PlayerProvider");
  return ctx;
}

export function usePlayerAdapter() {
  const ctx = useContext(PlayerAdapterCtx);
  if (!ctx) throw new Error("usePlayerAdapter requires PlayerProvider");
  return ctx;
}

function remoteActivityPosition(
  activity: PlaybackDevice["activity"],
): number {
  if (!activity) return 0;
  if (!activity.is_playing) return activity.position_sec;
  const updatedAt = Date.parse(activity.updated_at);
  const elapsed = Number.isFinite(updatedAt)
    ? Math.max(0, (Date.now() - updatedAt) / 1000)
    : 0;
  return Math.min(
    activity.duration_sec || Infinity,
    activity.position_sec + elapsed,
  );
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
        ? {
            ...state,
            volume: Math.max(0, Math.min(1, args.volume)),
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
