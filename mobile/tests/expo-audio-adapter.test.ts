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
// React is shimmed below; this factory performs a single render of the hook.
import { useExpoAudioAdapter as createTestAdapter } from "../adapters/expo-audio-adapter";

const h = vi.hoisted(() => {
  const calls: string[] = [];
  let resolveSeek: (() => void) | null = null;
  let rejectSeek: (() => void) | null = null;
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
    seekTo: (seconds: number) => {
      calls.push("seekTo");
      return new Promise<void>((resolve, reject) => {
        resolveSeek = () => {
          fakePlayer.currentTime = seconds;
          resolve();
        };
        rejectSeek = () => reject(new Error("seek failed"));
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
    captureSeekCompletion: () => resolveSeek,
    failSeek: () => rejectSeek?.(),
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

/** Yield so already-resolved promise chains inside the adapter can run. */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.restoreAllMocks();
  h.calls.length = 0;
  h.fakePlayer.currentTime = 0;
  h.fakePlayer.duration = 0;
  h.fakePlayer.currentStatus = {
    isLoaded: true, playing: false, didJustFinish: false, duration: 0,
  };
});

describe("useExpoAudioAdapter seek/play ordering", () => {
  it("holds play() until a pending seek settles (repeat-one restart)", async () => {
    const adapter = createTestAdapter();

    adapter.seek(0);
    const playPromise = adapter.play();
    await flushMicrotasks();
    expect(h.calls).toEqual(["seekTo"]);

    h.finishSeek();
    await playPromise;
    expect(h.calls).toEqual(["seekTo", "play"]);
  });

  it("plays immediately when no seek is pending", async () => {
    const adapter = createTestAdapter();

    await adapter.play();
    expect(h.calls).toEqual(["play"]);
  });

  it("does not let a stale seek on the outgoing track delay the next one", async () => {
    const adapter = createTestAdapter();

    adapter.seek(0);
    adapter.load("https://example.test/next.mp3");
    await adapter.play();
    expect(h.calls).toEqual(["seekTo", "replace", "play"]);
  });

  it("clears the pending seek once it settles", async () => {
    const adapter = createTestAdapter();

    adapter.seek(0);
    h.finishSeek();
    await flushMicrotasks();
    await adapter.play();
    expect(h.calls).toEqual(["seekTo", "play"]);
  });

  it.each(["load", "pause", "dispose"] as const)(
    "cancels a waiting restart when %s takes over",
    async (command) => {
      const adapter = createTestAdapter();
      adapter.seek(0);
      const pendingPlay = adapter.play();
      if (command === "load") adapter.load("https://example.test/next.mp3");
      else adapter[command]();
      h.finishSeek();
      await pendingPlay;
      expect(h.calls).not.toContain("play");
    },
  );

  it("reports seeked only after the native playhead has moved", async () => {
    const adapter = createTestAdapter();
    h.fakePlayer.currentTime = 40;
    const positions: number[] = [];
    adapter.on("seeked", () => positions.push(adapter.currentTime()));
    adapter.seek(90);
    expect(positions).toEqual([]);
    h.finishSeek();
    await flushMicrotasks();
    expect(positions).toEqual([90]);
  });

  it("does not publish a seek completion for a replaced track", async () => {
    const adapter = createTestAdapter();
    const seeked = vi.fn();
    adapter.on("seeked", seeked);
    adapter.seek(90);
    adapter.load("https://example.test/next.mp3");
    h.finishSeek();
    await flushMicrotasks();
    expect(seeked).not.toHaveBeenCalled();
  });

  it("ignores superseded and failed seeks", async () => {
    const adapter = createTestAdapter();
    const seeked = vi.fn();
    adapter.on("seeked", seeked);
    adapter.seek(10);
    const finishFirst = h.captureSeekCompletion();
    adapter.seek(90);
    finishFirst?.();
    await flushMicrotasks();
    expect(seeked).not.toHaveBeenCalled();
    h.failSeek();
    await flushMicrotasks();
    expect(seeked).not.toHaveBeenCalled();
    await adapter.play();
    expect(h.calls.at(-1)).toBe("play");
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
    const adapter = createTestAdapter();
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

  it("preserves the incoming metadata reset when ended loads the next track", () => {
    const { adapter } = setup();
    const metadata = vi.fn();
    h.emitStatus(playingStatus());
    adapter.on("loadedmetadata", metadata);
    adapter.on("ended", () => adapter.load("https://example.test/next.mp3"));

    h.emitStatus(status({ didJustFinish: true }));
    // Both songs have the same duration and the replacement is already loaded.
    h.emitStatus(playingStatus());
    expect(metadata).toHaveBeenCalledOnce();
  });
});

describe("useExpoAudioAdapter prepared track handoff", () => {
  const ready = { isLoaded: true, playing: false, didJustFinish: false, duration: 100 };

  async function prepare() {
    const adapter = createTestAdapter();
    adapter.prepareNext!("https://example.test/next.mp3");
    await flushMicrotasks();
    h.fakePlayer.currentStatus = { ...ready, isLoaded: false };
    expect(adapter.activatePrepared!("https://example.test/next.mp3")).toBe(true);
    return adapter;
  }

  it("pauses on deferred native play failure without throwing, then allows retry", async () => {
    const adapter = await prepare();
    const pause = vi.fn();
    const play = vi.fn();
    adapter.on("pause", pause);
    adapter.on("play", play);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("audio session activation failed");
    vi.spyOn(h.fakePlayer, "play").mockImplementationOnce(() => { throw error; });

    // Even a snapshot marked playing must not undo the failed-start pause.
    expect(() => h.emitStatus({ ...ready, playing: true })).not.toThrow();
    expect(pause).toHaveBeenCalledOnce();
    expect(play).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("Could not start prepared audio playback", error);

    await adapter.play();
    expect(h.calls.at(-1)).toBe("play");
  });

  it("ignores outgoing end events while the prepared replacement awaits playback", async () => {
    const adapter = await prepare();
    const ended = vi.fn();
    adapter.on("ended", ended);

    h.emitStatus({ ...ready, didJustFinish: true });
    expect(ended).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("play");

    h.emitStatus(ready);
    expect(h.calls.at(-1)).toBe("play");
    h.emitStatus({ ...ready, playing: true });
    h.emitStatus({ ...ready, didJustFinish: true });
    expect(ended).toHaveBeenCalledOnce();
  });

  it("publishes the loaded duration even when starting the prepared song fails", async () => {
    const adapter = await prepare();
    const durations: number[] = [];
    adapter.on("loadedmetadata", () => durations.push(adapter.duration()));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(h.fakePlayer, "play").mockImplementationOnce(() => {
      throw new Error("audio session activation failed");
    });
    h.fakePlayer.duration = ready.duration;

    h.emitStatus(ready);
    expect(durations).toEqual([100]);

    await adapter.play();
    h.emitStatus({ ...ready, playing: true });
    expect(durations).toEqual([100]);
  });

  it("honors pause while the prepared song is loading", async () => {
    const adapter = await prepare();
    adapter.pause();
    h.emitStatus(ready);
    expect(h.calls).not.toContain("play");
    await adapter.play();
    expect(h.calls.at(-1)).toBe("play");
  });

  it("does not start another song when the outgoing seek completes", async () => {
    const adapter = createTestAdapter();
    adapter.seek(0);
    const pendingPlay = adapter.play();
    adapter.prepareNext!("https://example.test/next.mp3");
    await flushMicrotasks();
    h.fakePlayer.currentStatus = ready;
    expect(adapter.activatePrepared!("https://example.test/next.mp3")).toBe(true);
    adapter.pause();
    h.finishSeek();
    await pendingPlay;
    expect(h.calls).toEqual(["seekTo", "replace", "play", "pause"]);
  });
});
