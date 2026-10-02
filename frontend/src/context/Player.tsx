import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  asyncifySyncStorage,
  usePlaybackActivityPublisher,
  usePlayerCore,
  useRemotePlaybackController,
  type AudioAdapter,
  type PlayerControls,
  type PlayerState,
  type RemotePlaybackContextValue,
  type TimeState,
} from "@music-library/core";
import { useHtmlAudioAdapter } from "../adapters/html-audio-adapter";
import { AudioOutputProvider } from "../lib/audioOutput";
import { useKey } from "../lib/keybindings";
import { isElectron } from "../lib/platform";
import { useMediaSession } from "../lib/useMediaSession";
import { usePageVisible } from "../lib/usePageVisible";
import { useAuth } from "./Auth";

type Ctx = PlayerState & PlayerControls;

const PlayerCtx = createContext<Ctx | null>(null);
const PlayerControlsCtx = createContext<PlayerControls | null>(null);
const PlayerTimeCtx = createContext<TimeState | null>(null);
const RemotePlaybackCtx = createContext<RemotePlaybackContextValue | null>(null);
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
 * Remote playback comes from the shared `useRemotePlaybackController`. The
 * bits that remain here are all web-only integrations: the Media Session API,
 * global keyboard shortcuts, and rendering the `<audio>` element the adapter
 * drives.
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const { status, me } = useAuth();
  const { adapter, audioRefs } = useHtmlAudioAdapter();
  // Nothing shows the clock while the page is hidden; like mobile's
  // app-state gate, stop sampling it until the page is visible again.
  const pageVisible = usePageVisible();
  const { state, controls, time } = usePlayerCore({
    adapter,
    storage: webStorage,
    interpolateProgress: pageVisible,
  });
  usePlaybackActivityPublisher({
    state,
    time,
    storage: webStorage,
    deviceName: isElectron() ? "Desktop" : "Web",
    adapter,
    controls,
    controlEnabled: true,
    enabled: status === "authed" && !me?.must_reset_password,
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
    clockEnabled: pageVisible,
  });
  useMediaSession({
    track: state.current,
    playing: state.isPlaying,
    controls,
    casting: !!remote.targetDevice,
  });
  const shownVolume = displayedState.volume;

  const latestControls = useRef(routedControls);
  useEffect(() => { latestControls.current = routedControls; }, [routedControls]);
  const stableControls = useMemo<PlayerControls>(() => ({
    play: (...args) => latestControls.current.play(...args),
    resume: (...args) => latestControls.current.resume(...args),
    pause: (...args) => latestControls.current.pause(...args),
    toggle: (...args) => latestControls.current.toggle(...args),
    next: (...args) => latestControls.current.next(...args),
    prev: (...args) => latestControls.current.prev(...args),
    jumpTo: (...args) => latestControls.current.jumpTo(...args),
    seek: (...args) => latestControls.current.seek(...args),
    setVolume: (...args) => latestControls.current.setVolume(...args),
    setMuted: (...args) => latestControls.current.setMuted(...args),
    toggleMute: (...args) => latestControls.current.toggleMute(...args),
    setShuffle: (...args) => latestControls.current.setShuffle(...args),
    toggleShuffle: (...args) => latestControls.current.toggleShuffle(...args),
    setRepeat: (...args) => latestControls.current.setRepeat(...args),
    cycleRepeat: (...args) => latestControls.current.cycleRepeat(...args),
  }), []);

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
    () => ({ ...displayedState, ...routedControls }),
    [displayedState, routedControls],
  );
  return (
    <RemotePlaybackCtx.Provider value={remote}>
      <PlayerControlsCtx.Provider value={stableControls}>
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
      </PlayerControlsCtx.Provider>
    </RemotePlaybackCtx.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer requires PlayerProvider");
  return ctx;
}

export function usePlayerControls() {
  const ctx = useContext(PlayerControlsCtx);
  if (!ctx) throw new Error("usePlayerControls requires PlayerProvider");
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
