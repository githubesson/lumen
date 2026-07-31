/**
 * Ordering tests for the expo-audio adapter. expo-audio's `seekTo` is an async
 * native function while `play` is sync, so an unawaited `seek(0)` + `play()`
 * pair (the repeat-one restart) can reach the native player in reverse order —
 * on iOS the reversed play() is consumed by the still-ended item and playback
 * stays paused at 0:00. The adapter must hold play() until the pending seek
 * settles.
 *
 * The adapter is a hook, but for a single render its hooks are trivial, so
 * React is shimmed and the hook is called as a plain function.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const calls: string[] = [];
  let resolveSeek: (() => void) | null = null;
  let statusListener: ((status: unknown) => void) | null = null;
  const fakePlayer = {
    currentStatus: { isLoaded: true, playing: false, didJustFinish: false, duration: 0 },
    addListener: (_event: string, cb: (status: unknown) => void) => {
      statusListener = cb;
      return { remove: () => {} };
    },
    play: () => {
      calls.push("play");
    },
    pause: () => {
      calls.push("pause");
    },
    seekTo: (_seconds: number) => {
      calls.push("seekTo");
      return new Promise<void>((resolve) => {
        resolveSeek = resolve;
      });
    },
    replace: (_source: { uri: string }) => {
      calls.push("replace");
    },
    currentTime: 0,
    duration: 0,
  };
  return {
    calls,
    fakePlayer,
    finishSeek: () => resolveSeek?.(),
    emitStatus: (status: unknown) => statusListener?.(status),
  };
});

vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (initial: unknown) => ({ current: initial }),
  // Run effects immediately so the status-subscription effect registers its
  // listener on the fake player; cleanups are dropped (each test calls the
  // hook once and never re-renders).
  useEffect: (fn: () => unknown) => {
    fn();
  },
}));

vi.mock("expo-audio", () => ({
  clearPreloadedSource: async () => {},
  preload: async () => {},
}));

vi.mock("expo-modules-core", () => ({
  useReleasingSharedObject: (factory: () => unknown) => factory(),
}));

vi.mock("expo-audio/build/AudioModule", () => ({
  default: {
    AudioPlayer: class {
      constructor() {
        return h.fakePlayer;
      }
    },
  },
}));

import { useExpoAudioAdapter } from "../adapters/expo-audio-adapter";

/** Yield so already-resolved promise chains inside the adapter can run. */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe("useExpoAudioAdapter seek/play ordering", () => {
  beforeEach(() => {
    h.calls.length = 0;
  });

  it("holds play() until a pending seek settles (repeat-one restart)", async () => {
    const adapter = useExpoAudioAdapter();

    adapter.seek(0);
    const playPromise = adapter.play();
    await flushMicrotasks();
    expect(h.calls).toEqual(["seekTo"]);

    h.finishSeek();
    await playPromise;
    expect(h.calls).toEqual(["seekTo", "play"]);
  });

  it("plays immediately when no seek is pending", async () => {
    const adapter = useExpoAudioAdapter();

    await adapter.play();
    expect(h.calls).toEqual(["play"]);
  });

  it("does not let a stale seek on the outgoing track delay the next one", async () => {
    const adapter = useExpoAudioAdapter();

    adapter.seek(0);
    adapter.load("https://example.test/next.mp3");
    await adapter.play();
    expect(h.calls).toEqual(["seekTo", "replace", "play"]);
  });

  it("clears the pending seek once it settles", async () => {
    const adapter = useExpoAudioAdapter();

    adapter.seek(0);
    h.finishSeek();
    await flushMicrotasks();
    await adapter.play();
    expect(h.calls).toEqual(["seekTo", "play"]);
  });
});

/**
 * Status → event translation. The shared core mirrors `pause` events straight
 * into `isPlaying`, so the adapter must dispatch `pause` only for genuine
 * pauses (user or system) — never for buffering stalls, natural track end, or
 * the paused statuses a source swap passes through.
 */
describe("useExpoAudioAdapter status → event translation", () => {
  const status = (over: Record<string, unknown>) => ({
    isLoaded: true,
    playing: false,
    didJustFinish: false,
    duration: 100,
    timeControlStatus: "paused",
    reasonForWaitingToPlay: "unknown",
    ...over,
  });
  const playingStatus = () =>
    status({ playing: true, timeControlStatus: "playing" });

  function setup() {
    const adapter = useExpoAudioAdapter();
    const events: string[] = [];
    adapter.on("play", () => events.push("play"));
    adapter.on("pause", () => events.push("pause"));
    adapter.on("ended", () => events.push("ended"));
    return { adapter, events };
  }

  it("dispatches pause when the system pauses playback (route loss, interruption)", () => {
    const { events } = setup();

    h.emitStatus(playingStatus());
    h.emitStatus(status({ playing: false, timeControlStatus: "paused" }));
    expect(events).toEqual(["play", "pause"]);
  });

  it("does not dispatch pause for a rebuffering stall", () => {
    const { events } = setup();

    h.emitStatus(playingStatus());
    h.emitStatus(
      status({
        playing: false,
        timeControlStatus: "waitingToPlayAtSpecifiedRate",
        reasonForWaitingToPlay: "toMinimizeStalls",
      }),
    );
    h.emitStatus(playingStatus());
    expect(events).toEqual(["play"]);
  });

  it("dispatches pause when the user pauses during a stall", () => {
    const { events } = setup();

    h.emitStatus(playingStatus());
    h.emitStatus(
      status({
        playing: false,
        timeControlStatus: "waitingToPlayAtSpecifiedRate",
        reasonForWaitingToPlay: "toMinimizeStalls",
      }),
    );
    h.emitStatus(status({ playing: false, timeControlStatus: "paused" }));
    expect(events).toEqual(["play", "pause"]);
  });

  it("dispatches ended but not pause at natural track end", () => {
    const { events } = setup();

    h.emitStatus(playingStatus());
    h.emitStatus(status({ playing: false, didJustFinish: true }));
    expect(events).toEqual(["play", "ended"]);
  });

  it("does not dispatch pause for the source swap in load()", () => {
    const { adapter, events } = setup();

    h.emitStatus(playingStatus());
    adapter.load("https://example.test/next.mp3");
    // The incoming item reports paused/not-loaded until it starts.
    h.emitStatus(status({ playing: false, isLoaded: false, duration: 0 }));
    h.emitStatus(playingStatus());
    expect(events).toEqual(["play", "play"]);
  });
});
