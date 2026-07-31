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
  buildRemoteQueue,
  clampVolume,
  compactRemoteTrack,
  controlledStateForDevice,
  filterRemoteDevices,
  nextRepeatMode,
  remoteActivityTime,
  useRemotePlaybackCommands,
  usePlaybackActivityPublisher,
  usePlaybackRemoteSession,
  usePlayerCore,
  type AudioAdapter,
  type PlaybackDevice,
  type PlayerControls,
  type PlayerState,
  type RemotePlaybackCommandAction,
  type RemotePlaybackCommandResult,
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
  const remoteDevices = useMemo(
    () => filterRemoteDevices(remoteSession.devices, remoteSession.deviceId),
    [remoteSession.deviceId, remoteSession.devices],
  );
  const targetDevice = useMemo(
    () =>
      remoteDevices.find((device) => device.deviceId === targetDeviceId) ??
      null,
    [remoteDevices, targetDeviceId],
  );
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
    initialState: {
      volume: state.volume,
      muted: state.muted,
      shuffle: state.shuffle,
      repeat: state.repeat,
    },
  });

  useEffect(() => {
    if (targetDeviceId && remoteSession.connected && !targetDevice) {
      setTargetDeviceId(null);
    }
  }, [remoteSession.connected, targetDevice, targetDeviceId]);

  // Destructured so this callback's identity tracks only the fields it reads.
  // Depending on `state` wholesale would also rebuild it on every queue change,
  // and it is handed to consumers through the remote-playback context.
  const { isPlaying, muted, repeat, shuffle, volume } = state;
  const selectTarget = useCallback(
    (nextDeviceId: string | null) => {
      if (nextDeviceId && isPlaying) controls.pause();
      setTargetDeviceId(nextDeviceId);
      seedControlled(
        controlledStateForDevice(
          remoteDevices.find((device) => device.deviceId === nextDeviceId),
          { volume, muted, shuffle, repeat },
        ),
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
            remoteActivityTime(targetDevice.activity).currentTime - 5,
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
            remoteActivityTime(targetDevice.activity).currentTime + 5,
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
          volume: clampVolume(controlled.volume + 0.05),
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
          volume: clampVolume(controlled.volume - 0.05),
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
      void sendCommand("set_muted", { muted: !controlled.muted });
    }
    else controls.toggleMute();
  }, {
    id: "player:mute",
    label: "Mute / unmute",
    group: "Playback",
  });
  useKey("s", () => {
    if (targetDevice) {
      void sendCommand("set_shuffle", { shuffle: !controlled.shuffle });
    } else controls.toggleShuffle();
  }, {
    id: "player:shuffle",
    label: "Shuffle",
    group: "Playback",
  });
  useKey("r", () => {
    if (targetDevice) {
      void sendCommand("set_repeat", {
        repeat: nextRepeatMode(controlled.repeat),
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
      controlledVolume: controlled.volume,
      controlledMuted: controlled.muted,
      controlledShuffle: controlled.shuffle,
      controlledRepeat: controlled.repeat,
      commandPending,
      lastCommandResult,
      selectTarget,
      sendCommand,
    }),
    [
      commandPending,
      controlled,
      lastCommandResult,
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

