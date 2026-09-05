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
  controlledStateForDevice,
  filterRemoteDevices,
  useRemoteActivityClock,
  useRemotePlaybackCommands,
  usePlaybackActivityPublisher,
  usePlaybackRemoteSession,
  usePlayerCore,
  useRoutedPlayerControls,
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

const EMPTY_REMOTE_QUEUE: PlayerState["queue"] = [];

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
  // While controlling another device, `usePlayerTime` consumers (lyrics, most
  // visibly) need the target's clock, not the paused local one — and ticking,
  // since heartbeats only arrive every ~10s.
  const remoteTime = useRemoteActivityClock(targetDevice?.activity);
  const displayedTime = targetDevice ? remoteTime : time;
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
      // The remote device list is an external subscription; clear a selected
      // target when that source confirms it disappeared.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  // Destructure the media-session inputs so the effect tracks exactly what it
  // reads without depending on the larger state/control objects.
  const mediaTrack = state.current;
  const mediaPlaying = state.isPlaying;
  const mediaToggle = controls.toggle;
  const mediaPrevious = controls.prev;
  const mediaNext = controls.next;
  const mediaSeek = controls.seek;

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
    if (!mediaTrack) {
      clear();
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: mediaTrack.title,
      artist: mediaTrack.artist ?? "",
      album: mediaTrack.album_title ?? "",
    });
    // Discrete play/pause (previously both fired the same toggle, so the OS
    // "play" button could pause an already-playing track and vice versa).
    navigator.mediaSession.setActionHandler("play", () => {
      if (!mediaPlaying) mediaToggle();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      if (mediaPlaying) mediaToggle();
    });
    navigator.mediaSession.setActionHandler("previoustrack", mediaPrevious);
    navigator.mediaSession.setActionHandler("nexttrack", mediaNext);
    navigator.mediaSession.setActionHandler("seekto", (e) => {
      if (typeof e.seekTime === "number") mediaSeek(e.seekTime);
    });
    return clear;
  }, [
    mediaTrack,
    mediaPlaying,
    mediaToggle,
    mediaPrevious,
    mediaNext,
    mediaSeek,
  ]);

  const routedControls = useRoutedPlayerControls({
    controls,
    targetDevice,
    controlled,
    sendCommand,
    // Web does not expose a remote queue yet.
    remoteQueue: EMPTY_REMOTE_QUEUE,
  });
  const shownVolume = targetDevice ? controlled.volume : state.volume;

  // Keyboard bindings use the same routing as buttons and command-palette actions.
  useKey("space", (event) => {
    event.preventDefault();
    routedControls.toggle();
  }, { id: "player:toggle" });
  useKey("left", () => {
    routedControls.seek(Math.max(0, displayedTime.currentTime - 5));
  }, { id: "player:seek-back" });
  useKey("right", () => {
    routedControls.seek(Math.min(displayedTime.duration || Infinity, displayedTime.currentTime + 5));
  }, { id: "player:seek-fwd" });
  useKey("up", (event) => {
    event.preventDefault();
    routedControls.setVolume(shownVolume + 0.05);
  }, { id: "player:vol-up" });
  useKey("down", (event) => {
    event.preventDefault();
    routedControls.setVolume(shownVolume - 0.05);
  }, { id: "player:vol-down" });
  useKey("n", routedControls.next, { id: "player:next" });
  useKey("p", routedControls.prev, { id: "player:prev" });
  useKey("m", routedControls.toggleMute, { id: "player:mute" });
  useKey("s", routedControls.toggleShuffle, { id: "player:shuffle" });
  useKey("r", routedControls.cycleRepeat, { id: "player:repeat" });

  const value = useMemo<Ctx>(
    () => ({ ...state, ...routedControls }),
    [state, routedControls],
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
        <PlayerTimeCtx.Provider value={displayedTime}>
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
