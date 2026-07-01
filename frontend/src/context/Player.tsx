import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import {
  asyncifySyncStorage,
  usePlaybackActivityPublisher,
  usePlayerCore,
  type AudioAdapter,
  type PlayerControls,
  type PlayerState,
  type TimeState,
} from "@music-library/core";
import { useHtmlAudioAdapter } from "../adapters/html-audio-adapter";
import { AudioOutputProvider } from "../lib/audioOutput";
import { useKey } from "../lib/keybindings";

type Ctx = PlayerState & PlayerControls;

const PlayerCtx = createContext<Ctx | null>(null);
const PlayerTimeCtx = createContext<TimeState | null>(null);
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
  const { adapter, audioRef } = useHtmlAudioAdapter();
  const { state, controls, time } = usePlayerCore({
    adapter,
    storage: webStorage,
  });
  usePlaybackActivityPublisher({
    state,
    time,
    storage: webStorage,
    deviceName: "Desktop",
  });

  // Media Session API — surface in OS media controls / Bluetooth buttons.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !state.current) return;
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
      controls.toggle();
    },
    { id: "player:toggle", label: "Play / pause", group: "Playback" },
  );
  useKey(
    "left",
    () => controls.seek(Math.max(0, time.currentTime - 5)),
    { id: "player:seek-back", label: "Seek back 5s", group: "Playback" },
  );
  useKey(
    "right",
    () =>
      controls.seek(
        Math.min(time.duration || Infinity, time.currentTime + 5),
      ),
    { id: "player:seek-fwd", label: "Seek forward 5s", group: "Playback" },
  );
  useKey(
    "up",
    (e) => {
      e.preventDefault();
      controls.setVolume(state.volume + 0.05);
    },
    { id: "player:vol-up", label: "Volume up", group: "Playback" },
  );
  useKey(
    "down",
    (e) => {
      e.preventDefault();
      controls.setVolume(state.volume - 0.05);
    },
    { id: "player:vol-down", label: "Volume down", group: "Playback" },
  );
  useKey("n", () => controls.next(), {
    id: "player:next",
    label: "Next track",
    group: "Playback",
  });
  useKey("p", () => controls.prev(), {
    id: "player:prev",
    label: "Previous track",
    group: "Playback",
  });
  useKey("m", () => controls.toggleMute(), {
    id: "player:mute",
    label: "Mute / unmute",
    group: "Playback",
  });
  useKey("s", () => controls.toggleShuffle(), {
    id: "player:shuffle",
    label: "Shuffle",
    group: "Playback",
  });
  useKey("r", () => controls.cycleRepeat(), {
    id: "player:repeat",
    label: "Repeat",
    group: "Playback",
  });

  const value = useMemo<Ctx>(
    () => ({ ...state, ...controls }),
    [state, controls],
  );

  return (
    <PlayerCtx.Provider value={value}>
      <PlayerTimeCtx.Provider value={time}>
        <PlayerAdapterCtx.Provider value={adapter}>
          <AudioOutputProvider audioRef={audioRef}>
            {children}
            <audio ref={audioRef} preload="metadata" />
          </AudioOutputProvider>
        </PlayerAdapterCtx.Provider>
      </PlayerTimeCtx.Provider>
    </PlayerCtx.Provider>
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

export function usePlayerAdapter() {
  const ctx = useContext(PlayerAdapterCtx);
  if (!ctx) throw new Error("usePlayerAdapter requires PlayerProvider");
  return ctx;
}
