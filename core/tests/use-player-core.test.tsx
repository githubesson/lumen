// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackListItem } from "../src/api";
import { api } from "../src/api";
import type { AudioAdapter, AudioAdapterEvent } from "../src/player/audio-adapter";
import type { Storage } from "../src/storage";
import {
  usePlayerCore,
  type UsePlayerCoreOptions,
} from "../src/player/use-player-core";

// use-player-core only touches the network through these; keep them silent.
vi.mock("../src/api", () => ({
  api: {
    updateNowPlaying: vi.fn(() => Promise.resolve()),
    recordPlay: vi.fn(() => Promise.resolve()),
    scrobbleTrack: vi.fn(() => Promise.resolve()),
  },
  streamUrl: (id: string) => `test://stream/${id}`,
}));

const t = (id: string): TrackListItem => ({
  id,
  title: `Track ${id}`,
  duration_ms: 180_000,
});

function createFakeAdapter() {
  const listeners = new Map<AudioAdapterEvent, Set<() => void>>();
  const state = {
    url: null as string | null,
    time: 0,
    dur: 0,
    playing: false,
  };
  const adapter: AudioAdapter = {
    load: vi.fn((url: string) => {
      state.url = url;
      state.time = 0;
    }),
    play: vi.fn(async () => {
      state.playing = true;
    }),
    pause: vi.fn(() => {
      state.playing = false;
    }),
    seek: vi.fn((seconds: number) => {
      state.time = seconds;
    }),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    prepareNext: vi.fn(),
    currentTime: () => state.time,
    duration: () => state.dur,
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return () => {
        set!.delete(handler);
      };
    },
    dispose: vi.fn(),
  };
  const emit = (event: AudioAdapterEvent) => {
    for (const fn of listeners.get(event) ?? []) fn();
  };
  return { adapter, state, emit };
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
  };
}

async function setup(options: Partial<UsePlayerCoreOptions> = {}) {
  const fake = createFakeAdapter();
  const utils = renderHook(() =>
    usePlayerCore({
      adapter: fake.adapter,
      storage: createMemoryStorage(),
      interpolateProgress: false,
      ...options,
    }),
  );
  // Flush the volume-hydration microtask so later assertions are stable.
  await act(async () => {});
  return { ...fake, ...utils };
}

const queue4 = () => [t("a"), t("b"), t("c"), t("d")];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePlayerCore", () => {
  it("play() loads the track, sets the queue and starts playback", async () => {
    const { result, adapter, state } = await setup();
    act(() => result.current.controls.play(t("b"), queue4()));

    expect(result.current.state.current?.id).toBe("b");
    expect(result.current.state.queue.map((x) => x.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(result.current.state.index).toBe(1);
    expect(result.current.state.isPlaying).toBe(true);
    expect(adapter.load).toHaveBeenCalledWith("test://stream/b");
    expect(state.url).toBe("test://stream/b");
  });

  it("play() with shuffle on pins the chosen track at index 0", async () => {
    const { result } = await setup();
    act(() => result.current.controls.setShuffle(true));
    act(() => result.current.controls.play(t("c"), queue4()));

    expect(result.current.state.current?.id).toBe("c");
    expect(result.current.state.index).toBe(0);
    expect(result.current.state.queue[0]?.id).toBe("c");
    expect([...result.current.state.queue.map((x) => x.id)].sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("next() advances and stops at the end of the queue", async () => {
    const { result } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));

    act(() => result.current.controls.next());
    expect(result.current.state.current?.id).toBe("b");

    act(() => result.current.controls.next());
    expect(result.current.state.isPlaying).toBe(false);
    expect(result.current.state.current?.id).toBe("b");
  });

  it("next() wraps to the start with repeat=all", async () => {
    const { result } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));
    act(() => result.current.controls.setRepeat("all"));

    act(() => result.current.controls.next());
    act(() => result.current.controls.next());
    expect(result.current.state.current?.id).toBe("a");
    expect(result.current.state.isPlaying).toBe(true);
  });

  it("repeat=one restarts the same track on ended", async () => {
    const { result, adapter, state, emit } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));
    act(() => result.current.controls.setRepeat("one"));
    state.time = 42;
    state.dur = 180;

    act(() => emit("ended"));
    expect(adapter.seek).toHaveBeenCalledWith(0);
    expect(result.current.state.current?.id).toBe("a");
    expect(result.current.state.isPlaying).toBe(true);
  });

  it("the playable gate skips blocked tracks when advancing", async () => {
    const { result } = await setup({
      isTrackPlayable: (id) => id !== "b",
    });
    act(() => result.current.controls.play(t("a"), [t("a"), t("b"), t("c")]));

    act(() => result.current.controls.next());
    expect(result.current.state.current?.id).toBe("c");
  });

  it("stops instead of looping when nothing ahead is playable", async () => {
    const { result } = await setup({
      isTrackPlayable: (id) => id === "a",
    });
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));

    act(() => result.current.controls.next());
    expect(result.current.state.isPlaying).toBe(false);
    expect(result.current.state.current?.id).toBe("a");
  });

  it("prev() restarts the track when more than 3s in, else goes back", async () => {
    const { result, adapter, state } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));
    act(() => result.current.controls.next());
    expect(result.current.state.current?.id).toBe("b");

    state.time = 10;
    act(() => result.current.controls.prev());
    expect(adapter.seek).toHaveBeenCalledWith(0);
    expect(result.current.state.current?.id).toBe("b");

    state.time = 1;
    act(() => result.current.controls.prev());
    expect(result.current.state.current?.id).toBe("a");
  });

  it("toggling shuffle off restores the original order at the current track", async () => {
    const { result } = await setup();
    act(() => result.current.controls.play(t("b"), queue4()));

    act(() => result.current.controls.toggleShuffle());
    expect(result.current.state.queue[0]?.id).toBe("b");

    act(() => result.current.controls.toggleShuffle());
    expect(result.current.state.queue.map((x) => x.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(result.current.state.index).toBe(1);
  });

  it("jumpTo() ignores taps on gated tracks", async () => {
    const { result } = await setup({
      isTrackPlayable: (id) => id !== "b",
    });
    act(() => result.current.controls.play(t("a"), [t("a"), t("b"), t("c")]));

    act(() => result.current.controls.jumpTo(1));
    expect(result.current.state.current?.id).toBe("a");

    act(() => result.current.controls.jumpTo(2));
    expect(result.current.state.current?.id).toBe("c");
  });

  it("prev() at the first track restarts it instead of no-oping", async () => {
    const { result, adapter, state } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));
    state.time = 1;

    act(() => result.current.controls.prev());
    expect(adapter.seek).toHaveBeenCalledWith(0);
    expect(result.current.state.current?.id).toBe("a");
    expect(result.current.state.index).toBe(0);
  });

  it("does not preload the current track as \"next\" at the queue end", async () => {
    const { result, adapter, state, emit } = await setup();
    act(() => result.current.controls.play(t("b"), [t("a"), t("b")]));
    state.dur = 100;
    state.time = 80;

    act(() => emit("timeupdate"));
    expect(adapter.prepareNext).not.toHaveBeenCalled();
  });

  it("mirrors an adapter pause event into isPlaying (system pause)", async () => {
    const { result, emit } = await setup();
    act(() => result.current.controls.play(t("a"), queue4()));
    expect(result.current.state.isPlaying).toBe(true);

    // e.g. iOS pauses the player itself when headphones disconnect or an
    // interruption begins; the only signal is the adapter's pause event.
    act(() => emit("pause"));
    expect(result.current.state.isPlaying).toBe(false);
  });

  it("mirrors an adapter play event into isPlaying (system resume)", async () => {
    const { result, emit } = await setup();
    act(() => result.current.controls.play(t("a"), queue4()));
    act(() => result.current.controls.pause());
    expect(result.current.state.isPlaying).toBe(false);

    // e.g. lock-screen play command handled natively, or an interruption
    // ending with auto-resume.
    act(() => emit("play"));
    await act(async () => {});
    expect(result.current.state.isPlaying).toBe(true);
  });

  it("reports a play exactly once past the 30s threshold", async () => {
    const { result, state, emit } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a")]));
    state.dur = 100;
    state.time = 31;

    act(() => emit("timeupdate"));
    expect(api.recordPlay).toHaveBeenCalledTimes(1);
    expect(api.recordPlay).toHaveBeenCalledWith("a", 0.31);

    act(() => emit("timeupdate"));
    expect(api.recordPlay).toHaveBeenCalledTimes(1);
  });
});
