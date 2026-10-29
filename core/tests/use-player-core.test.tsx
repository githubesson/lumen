// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const ids = (tracks: TrackListItem[]) => tracks.map((track) => track.id);

beforeEach(() => {
  vi.clearAllMocks();
  // A failed stream is asked for again; unless a test answers, it never is.
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePlayerCore", () => {
  it("gates direct play calls before changing the queue or loading a stream", async () => {
    let offline = false;
    const { result, adapter } = await setup({
      isTrackPlayable: (id) => !offline || id === "a",
      resolveTrackUri: (id) => id === "a" ? "file:///a.mp3" : undefined,
    });
    act(() => result.current.controls.play(t("a"), [t("a")]));
    act(() => result.current.controls.pause());
    const previousState = result.current.state;
    vi.mocked(adapter.load).mockClear();
    vi.mocked(adapter.play).mockClear();

    // Remote commands use these raw controls even when the socket stays online.
    offline = true;
    act(() => {
      expect(result.current.controls.play(t("b"), queue4())).toBe(false);
    });
    expect(result.current.state).toEqual(previousState);
    expect(adapter.load).not.toHaveBeenCalled();
    expect(adapter.play).not.toHaveBeenCalled();

    act(() => result.current.controls.play(t("a")));
    expect(result.current.state.isPlaying).toBe(true);
    offline = false;
    act(() => result.current.controls.play(t("b")));
    expect(adapter.load).toHaveBeenCalledWith("test://stream/b");
  });

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

  it("keeps a new pick when the old track ends before it commits", async () => {
    const { result, adapter, emit } = await setup();
    act(() => result.current.controls.play(t("a"), queue4()));
    act(() => result.current.controls.next());
    act(() => {
      result.current.controls.play(t("c"), [t("c"), t("d"), t("e")]);
      emit("ended");
    });
    expect(result.current.state.current?.id).toBe("c");
    expect(result.current.state.index).toBe(0);
    expect(ids(result.current.state.queue)).toEqual(["c", "d", "e"]);
    expect(adapter.load).toHaveBeenLastCalledWith("test://stream/c");

    // A jump, too.
    act(() => {
      result.current.controls.jumpTo(2);
      emit("ended");
    });
    expect(result.current.state.current?.id).toBe("e");
    expect(result.current.state.index).toBe(2);
    expect(adapter.load).toHaveBeenLastCalledWith("test://stream/e");

    // Once it has committed, its own end advances as usual.
    act(() => result.current.controls.prev());
    act(() => emit("ended"));
    expect(result.current.state.current?.id).toBe("e");
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

  it("starts every album handoff before React effects, including an unready preload and wrap", async () => {
    const { result, adapter, state, emit } = await setup();
    const album = queue4();
    adapter.activatePrepared = vi.fn(() => false);
    act(() => result.current.controls.play(album[0], album));
    act(() => result.current.controls.setRepeat("all"));
    state.dur = 180;

    for (let i = 1; i <= 12; i++) {
      state.time = 150;
      act(() => emit("timeupdate"));
      state.time = 180;
      state.playing = false;
      vi.mocked(adapter.play).mockClear();
      act(() => {
        emit("ended");
        // Assert inside the callback, before act flushes React's effects.
        // Background iOS playback cannot depend on that later render.
        expect(state.url).toBe(`test://stream/${album[i % album.length].id}`);
        expect(state.playing).toBe(true);
      });
      expect(adapter.play).toHaveBeenCalledTimes(1);
    }
  });

  it("does not issue a second play after a prepared album handoff", async () => {
    const { result, adapter, state, emit } = await setup();
    const album = queue4();
    adapter.activatePrepared = vi.fn((url) => {
      state.url = url;
      state.time = 0;
      state.playing = true;
      return true;
    });
    act(() => result.current.controls.play(album[0], album));
    state.dur = 180;
    state.time = 150;
    act(() => emit("timeupdate"));
    vi.mocked(adapter.play).mockClear();
    state.playing = false;
    act(() => {
      emit("ended");
      expect(state.url).toBe("test://stream/b");
      expect(state.playing).toBe(true);
    });
    expect(adapter.activatePrepared).toHaveBeenCalledWith("test://stream/b");
    expect(adapter.play).not.toHaveBeenCalled();
    expect(adapter.load).toHaveBeenCalledTimes(1);
  });

  it("reports a failed synchronous handoff even after React commits the next track", async () => {
    const { result, adapter, emit } = await setup();
    act(() => result.current.controls.play(t("a"), queue4()));
    let rejectHandoff!: (error: Error) => void;
    vi.mocked(adapter.play).mockReturnValueOnce(new Promise<void>((_, reject) => {
      rejectHandoff = reject;
    }));
    act(() => emit("ended"));
    expect(result.current.state.current?.id).toBe("b");
    await act(async () => rejectHandoff(new Error("native playback failed")));
    expect(result.current.state.isPlaying).toBe(false);
  });

  it.each([false, true])("restarts a single-track repeat-all queue without a ready preload (shuffle: %s)", async (shuffle) => {
    const { result, adapter, state, emit } = await setup();
    const track = t("a");
    act(() => result.current.controls.play(track, [track]));
    act(() => {
      result.current.controls.setRepeat("all");
      result.current.controls.setShuffle(shuffle);
    });
    state.dur = 180;
    act(() => emit("loadedmetadata"));

    for (let loop = 0; loop < 3; loop++) {
      state.time = 180;
      state.playing = false;
      act(() => emit("ended"));
      expect(state.time).toBe(0);
      expect(state.playing).toBe(true);
      expect(result.current.time.duration).toBe(180);
    }
    expect(adapter.load).toHaveBeenCalledTimes(1);
  });

  it("does not pause a new song when the previous play request rejects late", async () => {
    const { result, adapter, state } = await setup();
    let rejectOldPlay!: (error: Error) => void;
    const pending = new Promise<void>((_, reject) => { rejectOldPlay = reject; });
    vi.mocked(adapter.play).mockReturnValueOnce(pending);
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));
    act(() => result.current.controls.next());
    await act(async () => rejectOldPlay(new Error("source replaced")));
    expect(result.current.state.isPlaying).toBe(true);
    expect(state.playing).toBe(true);
  });

  it("reflects a failed loop restart as paused", async () => {
    const { result, adapter, emit } = await setup();
    act(() => result.current.controls.play(t("a")));
    act(() => result.current.controls.setRepeat("one"));
    vi.mocked(adapter.play).mockRejectedValueOnce(new Error("playback refused"));
    await act(async () => emit("ended"));
    expect(result.current.state.isPlaying).toBe(false);
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

  it("play() with shuffle turns the mode on with the new queue shuffled once", async () => {
    const { result } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));
    act(() => result.current.controls.play(t("c"), queue4(), { shuffle: true }));

    expect(result.current.state.shuffle).toBe(true);
    expect(result.current.state.current?.id).toBe("c");
    expect(result.current.state.index).toBe(0);
    expect(result.current.state.queue[0]?.id).toBe("c");
    expect(result.current.state.queue.map((x) => x.id).sort()).toEqual(["a", "b", "c", "d"]);

    // The list's own order comes back when shuffle goes off.
    act(() => result.current.controls.setShuffle(false));
    expect(result.current.state.queue.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.current.state.index).toBe(2);
  });

  it("a refused shuffle play leaves the mode and the playing queue alone", async () => {
    let offline = false;
    const { result } = await setup({ isTrackPlayable: (id) => !offline || id === "a" });
    act(() => result.current.controls.play(t("a"), queue4()));
    const before = result.current.state;
    offline = true;
    act(() => {
      expect(result.current.controls.play(t("b"), queue4(), { shuffle: true })).toBe(false);
    });
    expect(result.current.state).toEqual(before);
    expect(result.current.state.shuffle).toBe(false);
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

  it("writes a volume change still inside the debounce when the player unmounts", async () => {
    const storage = createMemoryStorage();
    const { result, unmount } = await setup({ storage });
    act(() => result.current.controls.setVolume(0.3));
    unmount();
    await act(async () => {});
    expect(await storage.getItem("mlib-volume")).toBe("0.3");
  });

  it("writes a pending volume change when the page is hidden for closing", async () => {
    const storage = createMemoryStorage();
    const { result } = await setup({ storage });
    act(() => result.current.controls.setVolume(0.7));
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(await storage.getItem("mlib-volume")).toBe("0.7");
  });
});


describe("usePlayerCore smooth mix", () => {
  // Playing `a` of queue4() 150s into 180s, with `b` prepared.
  async function nearTheEnd(options: Partial<UsePlayerCoreOptions> = {}, queue = queue4()) {
    const fake = await setup({ crossfadeSeconds: 6, ...options });
    fake.adapter.activatePrepared = vi.fn(() => true);
    fake.adapter.crossfadeToPrepared = vi.fn(() => true);
    act(() => fake.result.current.controls.play(queue[0], queue));
    fake.state.dur = 180;
    fake.state.time = 150;
    act(() => fake.emit("timeupdate"));
    expect(fake.adapter.prepareNext).toHaveBeenCalledWith(`test://stream/${queue[1].id}`);
    vi.mocked(fake.adapter.play).mockClear();
    return fake;
  }

  it("crossfades into the prepared track over what's left of this one", async () => {
    const { result, adapter, state, emit } = await nearTheEnd();
    state.time = 173;
    act(() => emit("timeupdate"));
    expect(adapter.crossfadeToPrepared).not.toHaveBeenCalled();

    state.time = 175;
    act(() => emit("timeupdate"));
    expect(adapter.crossfadeToPrepared).toHaveBeenCalledWith("test://stream/b", 5);
    expect(result.current.state.current?.id).toBe("b");
    expect(result.current.state.index).toBe(1);
    expect(result.current.state.isPlaying).toBe(true);
    // The adapter started it; nothing loads or plays it again.
    expect(adapter.activatePrepared).not.toHaveBeenCalled();
    expect(adapter.load).toHaveBeenCalledTimes(1);
    expect(adapter.play).not.toHaveBeenCalled();
  });

  it("plays on while the prepared track isn't ready, and tries again", async () => {
    const { result, adapter, state, emit } = await nearTheEnd();
    vi.mocked(adapter.crossfadeToPrepared!).mockReturnValueOnce(false);
    state.time = 175;
    act(() => emit("timeupdate"));
    expect(result.current.state.current?.id).toBe("a");
    expect(result.current.state.isPlaying).toBe(true);
    expect(adapter.load).toHaveBeenCalledTimes(1);

    state.time = 176;
    act(() => emit("timeupdate"));
    expect(adapter.crossfadeToPrepared).toHaveBeenLastCalledWith("test://stream/b", 4);
    expect(result.current.state.current?.id).toBe("b");
  });

  it("fades into a short song over half its length, without cutting this one", async () => {
    const queue = queue4();
    queue[1] = { ...queue[1], duration_ms: 4_000 };
    const { adapter, state, emit } = await nearTheEnd({}, queue);
    state.time = 175;
    act(() => emit("timeupdate"));
    expect(adapter.crossfadeToPrepared).not.toHaveBeenCalled();

    state.time = 178;
    act(() => emit("timeupdate"));
    expect(adapter.crossfadeToPrepared).toHaveBeenCalledWith("test://stream/b", 2);
  });

  it("goes on from the crossfaded track as usual", async () => {
    const { result, adapter, state, emit } = await nearTheEnd();
    state.time = 175;
    act(() => emit("timeupdate"));
    expect(result.current.state.current?.id).toBe("b");

    // Skipping mid-fade loads the track after it; nothing was prepared yet.
    act(() => result.current.controls.next());
    expect(adapter.load).toHaveBeenLastCalledWith("test://stream/c");
    expect(result.current.state.current?.id).toBe("c");

    // And c's own end hands off to d once, as any track's does.
    state.dur = 180;
    state.time = 150;
    act(() => emit("timeupdate"));
    expect(adapter.prepareNext).toHaveBeenLastCalledWith("test://stream/d");
    act(() => emit("ended"));
    expect(adapter.activatePrepared).toHaveBeenCalledOnce();
    expect(adapter.activatePrepared).toHaveBeenCalledWith("test://stream/d");
    expect(result.current.state.current?.id).toBe("d");
    expect(adapter.crossfadeToPrepared).toHaveBeenCalledOnce();
  });

  it("doesn't fade when a pause arrives with the same native status", async () => {
    const { result, adapter, state, emit } = await nearTheEnd();
    act(() => {
      emit("pause");
      state.time = 177;
      emit("timeupdate");
    });
    expect(adapter.crossfadeToPrepared).not.toHaveBeenCalled();
    expect(result.current.state.current?.id).toBe("a");
    expect(result.current.state.isPlaying).toBe(false);
  });

  it("doesn't fade out of a song that failed in the same batch", async () => {
    const { result, adapter, state, emit } = await nearTheEnd();
    act(() => {
      emit("error");
      state.time = 177;
      emit("timeupdate");
    });
    expect(adapter.crossfadeToPrepared).not.toHaveBeenCalled();
    expect(result.current.state.current?.id).toBe("a");
    expect(result.current.state.playbackError?.trackId).toBe("a");
  });

  it("prepares again after a pick that changes nothing", async () => {
    const { result, adapter, state, emit } = await nearTheEnd();
    vi.mocked(adapter.prepareNext!).mockClear();
    // Tapping the playing track in a queue (CarPlay, say) drops what was
    // prepared; the pick still commits, so the next update prepares again.
    act(() => result.current.controls.jumpTo(0));
    state.time = 160;
    act(() => emit("timeupdate"));
    expect(adapter.prepareNext).toHaveBeenCalledWith("test://stream/b");
    state.time = 177;
    act(() => emit("timeupdate"));
    expect(adapter.crossfadeToPrepared).toHaveBeenCalledWith("test://stream/b", 3);
  });

  it("still fades after a pause and a resume in one batch", async () => {
    const { result, adapter, state, emit } = await nearTheEnd();
    // A brief interruption: both statuses arrive before React renders, and
    // the two state changes cancel out.
    act(() => {
      emit("pause");
      emit("play");
    });
    expect(result.current.state.isPlaying).toBe(true);
    state.time = 177;
    act(() => emit("timeupdate"));
    expect(adapter.crossfadeToPrepared).toHaveBeenCalledWith("test://stream/b", 3);
  });

  it("doesn't fade into the old queue when a new one starts before it commits", async () => {
    const { result, adapter, state, emit } = await nearTheEnd();
    vi.mocked(adapter.prepareNext!).mockClear();
    // A remote command or CarPlay plays outside a React event; a timeupdate
    // can land before the new queue commits.
    act(() => {
      result.current.controls.play(t("x"), [t("x"), t("y")]);
      state.time = 177;
      emit("timeupdate");
    });
    expect(adapter.crossfadeToPrepared).not.toHaveBeenCalled();
    expect(adapter.prepareNext).not.toHaveBeenCalled();
    expect(result.current.state.current?.id).toBe("x");
    expect(result.current.state.queue.map((track) => track.id)).toEqual(["x", "y"]);
    expect(adapter.load).toHaveBeenLastCalledWith("test://stream/x");

    // Once it has, the new queue's next track is prepared as usual.
    state.dur = 180;
    state.time = 150;
    act(() => emit("timeupdate"));
    expect(adapter.prepareNext).toHaveBeenCalledWith("test://stream/y");
  });

  it("doesn't fade into the old order when shuffle changes before it commits", async () => {
    const { result, adapter, state, emit } = await nearTheEnd();
    // CarPlay's shuffle button runs outside a React event too.
    act(() => {
      result.current.controls.setShuffle(true);
      state.time = 177;
      emit("timeupdate");
    });
    expect(adapter.crossfadeToPrepared).not.toHaveBeenCalled();
    expect(result.current.state.current?.id).toBe("a");
    expect(result.current.state.index).toBe(0);
  });

  it("leaves the last second to the ordinary handoff", async () => {
    const { result, adapter, state, emit } = await nearTheEnd();
    state.time = 179.5;
    act(() => emit("timeupdate"));
    expect(adapter.crossfadeToPrepared).not.toHaveBeenCalled();

    act(() => emit("ended"));
    expect(adapter.activatePrepared).toHaveBeenCalledWith("test://stream/b");
    expect(result.current.state.current?.id).toBe("b");
  });

  it("runs an album playing in order straight through", async () => {
    const album = queue4().map((track, i) => ({ ...track, album_id: "x", track_no: i + 1 }));
    const { adapter, state, emit } = await nearTheEnd({}, album);
    state.time = 175;
    act(() => emit("timeupdate"));
    expect(adapter.crossfadeToPrepared).not.toHaveBeenCalled();
  });

  it("is off without a length, and while paused", async () => {
    const off = await nearTheEnd({ crossfadeSeconds: 0 });
    off.state.time = 175;
    act(() => off.emit("timeupdate"));
    expect(off.adapter.crossfadeToPrepared).not.toHaveBeenCalled();

    const paused = await nearTheEnd();
    act(() => paused.result.current.controls.pause());
    paused.state.time = 175;
    act(() => paused.emit("timeupdate"));
    expect(paused.adapter.crossfadeToPrepared).not.toHaveBeenCalled();
  });

  it("never fades into a fresh shuffle at the end of the queue", async () => {
    const { result, adapter, state, emit } = await nearTheEnd();
    act(() => result.current.controls.setShuffle(true));
    act(() => result.current.controls.setRepeat("all"));
    act(() => result.current.controls.jumpTo(3));
    for (const time of [150, 175]) {
      state.time = time;
      act(() => emit("timeupdate"));
    }
    expect(adapter.crossfadeToPrepared).not.toHaveBeenCalled();
    expect(result.current.state.index).toBe(3);
    expect(result.current.state.isPlaying).toBe(true);
  });
});

describe("usePlayerCore with unavailable tracks", () => {
  // Dropped from TIDAL with no library copy: no gate needed to skip them.
  const gone = (id: string): TrackListItem => ({ ...t(id), unavailable: true });

  it("refuses to start an unavailable track without touching the queue", async () => {
    const { result, adapter } = await setup();
    act(() => {
      expect(result.current.controls.play(gone("a"), [gone("a"), t("b")])).toBe(false);
    });
    expect(result.current.state.current).toBeNull();
    expect(result.current.state.queue).toEqual([]);
    expect(adapter.load).not.toHaveBeenCalled();
  });

  it("skips them on next, prev and auto-advance, and ignores jumps to them", async () => {
    const { result, emit, state } = await setup();
    const queue = [t("a"), gone("b"), t("c"), gone("d")];
    act(() => result.current.controls.play(t("a"), queue));

    act(() => result.current.controls.next());
    expect(result.current.state.current?.id).toBe("c");

    state.time = 0;
    act(() => result.current.controls.prev());
    expect(result.current.state.current?.id).toBe("a");

    act(() => result.current.controls.jumpTo(1));
    expect(result.current.state.current?.id).toBe("a");

    act(() => result.current.controls.jumpTo(2));
    // Only an unavailable track is left ahead: stop rather than land on it.
    act(() => emit("ended"));
    expect(result.current.state.current?.id).toBe("c");
    expect(result.current.state.isPlaying).toBe(false);
  });

  it("wraps past them with repeat=all, shuffled or not", async () => {
    const { result } = await setup();
    act(() => result.current.controls.play(t("b"), [gone("a"), t("b")]));
    act(() => result.current.controls.setRepeat("all"));
    act(() => result.current.controls.next());
    expect(result.current.state.current?.id).toBe("b");
    expect(result.current.state.isPlaying).toBe(true);

    act(() => result.current.controls.setShuffle(true));
    for (let i = 0; i < 5; i++) {
      act(() => result.current.controls.next());
      expect(result.current.state.current?.id).toBe("b");
    }
  });

  it("does not preload an unavailable next track", async () => {
    const { result, adapter, state, emit } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), gone("b"), t("c")]));
    state.dur = 100;
    state.time = 80;
    act(() => emit("timeupdate"));
    expect(adapter.prepareNext).toHaveBeenCalledExactlyOnceWith("test://stream/c");
  });
});

describe("usePlayerCore playback errors", () => {
  const tidal = (id: string): TrackListItem => ({ ...t(`tidal:${id}`), source: "tidal" });
  const refusal = "TIDAL refused to stream this track: Not available in your region";
  // The probe resolves over several promise hops; a macrotask drains them.
  const settle = () => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("stops on the failed track and shows the server's reason for a TIDAL stream", async () => {
    const fetchMock = vi.fn(async () => new Response(refusal, { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result, emit } = await setup();
    act(() => result.current.controls.play(tidal("1"), [tidal("1"), t("b")]));

    act(() => emit("error"));
    expect(result.current.state.isPlaying).toBe(false);
    await settle();
    expect(result.current.state.playbackError).toEqual({
      trackId: "tidal:1",
      message: refusal,
      details: {
        at: expect.any(Number),
        source: "test://stream/tidal:1",
        player: null,
        server: `HTTP 502 · ${refusal}`,
      },
    });
    expect(result.current.state.current?.id).toBe("tidal:1");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("test://stream/tidal:1", expect.anything());
  });

  it.each([
    ["a library track's refusal", t("a"), () => new Response(refusal, { status: 502 }), `HTTP 502 · ${refusal}`],
    ["a library file gone from disk", t("a"), () => new Response("file missing on disk", { status: 410 }), "HTTP 410 · file missing on disk"],
    ["a reverse proxy's HTML page", tidal("1"), () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }), "HTTP 502"],
    ["a stream that answers now", tidal("1"), () => new Response("#EXTM3U\n", { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" } }), "HTTP 200 · application/vnd.apple.mpegurl"],
    ["an error that isn't TIDAL's", tidal("1"), () => new Response("internal error", { status: 500 }), "HTTP 500 · internal error"],
    ["an unreachable server", tidal("1"), () => Promise.reject(new TypeError("Failed to fetch")), "No answer: TypeError: Failed to fetch"],
  ])("shows a generic message for %s, and the answer in the details", async (_case, track, respond, server) => {
    const fetchMock = vi.fn(async () => respond());
    vi.stubGlobal("fetch", fetchMock);
    const { result, emit } = await setup();
    act(() => result.current.controls.play(track));

    act(() => emit("error"));
    await settle();
    expect(result.current.state.playbackError).toMatchObject({
      trackId: track.id,
      message: "Couldn't play this track.",
      details: { server },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not ask the server about a downloaded TIDAL track", async () => {
    const fetchMock = vi.fn(async () => new Response(refusal, { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result, emit } = await setup({ resolveTrackUri: () => "file:///offline.flac" });
    act(() => result.current.controls.play(tidal("1")));

    act(() => emit("error"));
    await settle();
    expect(result.current.state.playbackError).toMatchObject({
      message: "Couldn't play this track.",
      details: { source: "file:///offline.flac", server: null },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps what the audio player said about the failure", async () => {
    const fake = createFakeAdapter();
    fake.adapter.errorDetail = () => "MEDIA_ERR_DECODE: PIPELINE_ERROR_DECODE";
    const { result } = renderHook(() =>
      usePlayerCore({
        adapter: fake.adapter,
        storage: createMemoryStorage(),
        interpolateProgress: false,
      }),
    );
    act(() => result.current.controls.play(t("a")));

    act(() => fake.emit("error"));
    expect(result.current.state.playbackError?.details.player).toBe(
      "MEDIA_ERR_DECODE: PIPELINE_ERROR_DECODE",
    );
  });

  it("keeps no address from what the audio player said, and caps it", async () => {
    const fake = createFakeAdapter();
    let said = 'hls.js keyLoadError: Invalid key URI: "https://cdn.example/key?token=secret"';
    fake.adapter.errorDetail = () => said;
    const { result } = renderHook(() =>
      usePlayerCore({
        adapter: fake.adapter,
        storage: createMemoryStorage(),
        interpolateProgress: false,
      }),
    );
    act(() => result.current.controls.play(t("a")));

    act(() => fake.emit("error"));
    expect(result.current.state.playbackError?.details.player).toBe(
      'hls.js keyLoadError: Invalid key URI: "<address>"',
    );

    said = `MEDIA_ERR_DECODE:\n${"x".repeat(400)}`;
    act(() => result.current.controls.toggle());
    act(() => fake.emit("error"));
    const player = result.current.state.playbackError?.details.player ?? "";
    expect(player).toHaveLength(300);
    expect(player.startsWith("MEDIA_ERR_DECODE: xxx")).toBe(true);
    expect(player.endsWith("…")).toBe(true);
  });

  it("shows a server address without its origin", async () => {
    const { result, emit } = await setup({
      resolveTrackUri: (id) => `https://music.example/api/tracks/${id}/stream`,
    });
    act(() => result.current.controls.play(t("a")));

    act(() => emit("error"));
    expect(result.current.state.playbackError?.details.source).toBe("/api/tracks/a/stream");
  });

  it("ignores a probe that answers after another track started", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    const { result, emit } = await setup();
    act(() => result.current.controls.play(tidal("1"), [tidal("1"), t("b")]));
    act(() => emit("error"));

    act(() => result.current.controls.next());
    answer(new Response(refusal, { status: 502 }));
    await settle();
    expect(result.current.state.current?.id).toBe("b");
    expect(result.current.state.playbackError).toBeNull();
  });

  it("clears the error when another track starts", async () => {
    const { result, emit } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));
    act(() => emit("error"));
    expect(result.current.state.playbackError?.trackId).toBe("a");

    act(() => result.current.controls.next());
    expect(result.current.state.playbackError).toBeNull();
    expect(result.current.state.isPlaying).toBe(true);
  });

  it.each(["toggle", "resume", "play"] as const)("reloads the failed track on %s", async (control) => {
    const { result, adapter, emit } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));
    act(() => emit("error"));
    vi.mocked(adapter.load).mockClear();
    vi.mocked(adapter.play).mockClear();

    act(() => {
      if (control === "play") result.current.controls.play(t("a"), [t("a"), t("b")]);
      else result.current.controls[control]();
    });
    expect(adapter.load).toHaveBeenCalledExactlyOnceWith("test://stream/a");
    expect(adapter.play).toHaveBeenCalledTimes(1);
    expect(result.current.state.isPlaying).toBe(true);
    expect(result.current.state.playbackError).toBeNull();
  });

  it("shows the generic message while it asks the server why", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    const { result, emit } = await setup();
    act(() => result.current.controls.play(tidal("1")));

    act(() => emit("error"));
    expect(result.current.state.playbackError?.message).toBe("Couldn't play this track.");
    expect(result.current.state.playbackError?.details.server).toBeUndefined();
    answer(new Response(refusal, { status: 502 }));
    await settle();
    expect(result.current.state.playbackError?.message).toBe(refusal);
  });

  it.each([
    ["more than 3s in", 10],
    ["with nothing behind it", 0],
  ])("reloads the failed track on prev %s", async (_case, time) => {
    const { result, adapter, emit, state } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));
    act(() => emit("error"));
    vi.mocked(adapter.load).mockClear();
    vi.mocked(adapter.seek).mockClear();

    state.time = time;
    act(() => result.current.controls.prev());
    expect(adapter.load).toHaveBeenCalledExactlyOnceWith("test://stream/a");
    expect(adapter.seek).not.toHaveBeenCalled();
    expect(result.current.state.isPlaying).toBe(true);
    expect(result.current.state.playbackError).toBeNull();
  });

  it("prepares the next track again after a retry", async () => {
    const { result, adapter, emit, state } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));
    state.dur = 100;
    state.time = 80;
    act(() => emit("timeupdate"));
    expect(adapter.prepareNext).toHaveBeenCalledTimes(1);

    act(() => emit("error"));
    act(() => result.current.controls.toggle());
    state.time = 80; // the reload started the track over
    act(() => emit("timeupdate"));
    expect(adapter.prepareNext).toHaveBeenCalledTimes(2);
    expect(adapter.prepareNext).toHaveBeenLastCalledWith("test://stream/b");
  });

  it("counts a retried track as a fresh listen", async () => {
    const { result, emit, state } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));
    state.dur = 100;
    state.time = 31;
    act(() => emit("timeupdate"));
    expect(api.recordPlay).toHaveBeenCalledTimes(1);

    act(() => emit("error"));
    act(() => result.current.controls.toggle());
    expect(result.current.state.isPlaying).toBe(true);
    state.time = 31; // the reload started the track over
    act(() => emit("timeupdate"));
    expect(api.recordPlay).toHaveBeenCalledTimes(2);
  });

  it("reloads a failed single-track loop instead of restarting it in place", async () => {
    const { result, adapter, emit } = await setup();
    act(() => result.current.controls.play(t("a")));
    act(() => result.current.controls.setRepeat("all"));
    act(() => emit("error"));
    vi.mocked(adapter.load).mockClear();

    act(() => result.current.controls.next());
    expect(adapter.load).toHaveBeenCalledExactlyOnceWith("test://stream/a");
    expect(result.current.state.playbackError).toBeNull();
  });
});

describe("usePlayerCore playNext", () => {

  it("puts tracks after the current one, in the order they were picked", async () => {
    const { result } = await setup();
    act(() => result.current.controls.play(t("a"), queue4()));
    act(() => {
      expect(result.current.controls.playNext([t("x")])).toBe(true);
    });
    act(() => {
      result.current.controls.playNext([t("y")]);
      // Before React commits, the second pick still lands behind the first.
      result.current.controls.playNext([t("z")]);
    });
    expect(ids(result.current.state.queue)).toEqual(["a", "x", "y", "z", "b", "c", "d"]);
    expect(result.current.state.index).toBe(0);
    expect(result.current.state.current?.id).toBe("a");

    act(() => result.current.controls.next());
    expect(result.current.state.current?.id).toBe("x");
  });

  it("starts a new run when the track changes", async () => {
    const { result } = await setup();
    act(() => result.current.controls.play(t("a"), queue4()));
    act(() => result.current.controls.playNext([t("x"), t("y")]));
    act(() => result.current.controls.next());
    act(() => result.current.controls.playNext([t("z")]));
    expect(ids(result.current.state.queue)).toEqual(["a", "x", "z", "y", "b", "c", "d"]);
  });

  it("starts a new run when the queue comes round to the same track", async () => {
    const { result } = await setup();
    act(() => result.current.controls.play(t("a"), [t("a"), t("b")]));
    act(() => result.current.controls.setRepeat("all"));
    act(() => result.current.controls.playNext([t("x")]));
    for (let i = 0; i < 3; i += 1) act(() => result.current.controls.next());
    expect(result.current.state.current?.id).toBe("a");
    act(() => result.current.controls.playNext([t("y")]));
    expect(ids(result.current.state.queue)).toEqual(["a", "y", "x", "b"]);
  });

  it("starts a new run when the same track is played anew, or the queue moves", async () => {
    const { result } = await setup();
    act(() => result.current.controls.play(t("a"), queue4()));
    act(() => result.current.controls.playNext([t("x")]));
    act(() => result.current.controls.play(t("a"), [t("a"), t("x"), t("c")]));
    act(() => result.current.controls.playNext([t("y")]));
    expect(ids(result.current.state.queue)).toEqual(["a", "y", "x", "c"]);

    // A jump back to the same track, and a shuffle change, end a run too.
    act(() => result.current.controls.jumpTo(0));
    act(() => result.current.controls.playNext([t("z")]));
    expect(ids(result.current.state.queue)).toEqual(["a", "z", "y", "x", "c"]);
    act(() => result.current.controls.setShuffle(true));
    act(() => result.current.controls.setShuffle(false));
    act(() => result.current.controls.playNext([t("w")]));
    expect(ids(result.current.state.queue)).toEqual(["a", "w", "z", "y", "x", "c"]);
  });

  it("moves a track that's already queued instead of adding it twice", async () => {
    const { result } = await setup();
    act(() => result.current.controls.play(t("b"), queue4()));
    act(() => result.current.controls.playNext([t("d")]));
    expect(ids(result.current.state.queue)).toEqual(["a", "b", "d", "c"]);
    // One that already played moves up too, and the current track stays put.
    act(() => result.current.controls.playNext([t("a")]));
    expect(ids(result.current.state.queue)).toEqual(["b", "d", "a", "c"]);
    expect(result.current.state.index).toBe(0);
    expect(result.current.state.current?.id).toBe("b");
  });

  it("leaves out the current track and tracks that can't start", async () => {
    const { result } = await setup({ isTrackPlayable: (id) => id !== "y" });
    act(() => result.current.controls.play(t("a"), queue4()));
    act(() => {
      expect(result.current.controls.playNext([t("a"), { ...t("x"), unavailable: true }, t("y")])).toBe(false);
    });
    expect(ids(result.current.state.queue)).toEqual(["a", "b", "c", "d"]);
  });

  it("plays the tracks when nothing is loaded", async () => {
    const { result, adapter } = await setup();
    act(() => {
      expect(result.current.controls.playNext([t("x"), t("y")])).toBe(true);
    });
    expect(result.current.state.current?.id).toBe("x");
    expect(ids(result.current.state.queue)).toEqual(["x", "y"]);
    expect(result.current.state.isPlaying).toBe(true);
    expect(adapter.load).toHaveBeenCalledWith("test://stream/x");
  });

  it("treats the rest of a first pick as a run when nothing was loaded", async () => {
    const { result } = await setup();
    act(() => result.current.controls.playNext([t("x"), t("y")]));
    act(() => result.current.controls.playNext([t("z")]));
    expect(ids(result.current.state.queue)).toEqual(["x", "y", "z"]);
    expect(result.current.state.current?.id).toBe("x");
  });

  it("plays a first pick in its own order with shuffle on", async () => {
    const { result } = await setup();
    act(() => result.current.controls.setShuffle(true));
    const picks = ["x", "y", "z", "w", "v"].map(t);
    act(() => result.current.controls.playNext(picks));
    expect(ids(result.current.state.queue)).toEqual(["x", "y", "z", "w", "v"]);
    expect(result.current.state.index).toBe(0);
    expect(result.current.state.shuffle).toBe(true);
    act(() => result.current.controls.playNext([t("u")]));
    expect(ids(result.current.state.queue)).toEqual(["x", "y", "z", "w", "v", "u"]);
    act(() => result.current.controls.setShuffle(false));
    expect(ids(result.current.state.queue)).toEqual(["x", "y", "z", "w", "v", "u"]);
  });

  it("stays next when shuffle is turned off", async () => {
    const { result } = await setup();
    act(() => result.current.controls.play(t("b"), queue4(), { shuffle: true }));
    act(() => result.current.controls.playNext([t("x")]));
    expect(result.current.state.queue[1]?.id).toBe("x");
    expect(result.current.state.queue).toHaveLength(5);

    act(() => result.current.controls.setShuffle(false));
    expect(ids(result.current.state.queue)).toEqual(["a", "b", "x", "c", "d"]);
    expect(result.current.state.index).toBe(1);
    act(() => result.current.controls.next());
    expect(result.current.state.current?.id).toBe("x");
  });

  it("swaps the prepared next track for the new one", async () => {
    const { result, adapter, state, emit } = await setup({ crossfadeSeconds: 6 });
    adapter.activatePrepared = vi.fn(() => true);
    adapter.crossfadeToPrepared = vi.fn(() => true);
    adapter.clearPrepared = vi.fn();
    act(() => result.current.controls.play(t("a"), queue4()));
    state.dur = 180;
    state.time = 150;
    act(() => emit("timeupdate"));
    expect(adapter.prepareNext).toHaveBeenLastCalledWith("test://stream/b");

    act(() => {
      result.current.controls.playNext([t("x")]);
      // A timeupdate before the queue commits mustn't fade into b.
      state.time = 176;
      emit("timeupdate");
    });
    expect(adapter.crossfadeToPrepared).not.toHaveBeenCalled();
    expect(adapter.clearPrepared).toHaveBeenCalled();

    state.time = 160;
    act(() => emit("timeupdate"));
    expect(adapter.prepareNext).toHaveBeenLastCalledWith("test://stream/x");
    state.time = 176;
    act(() => emit("timeupdate"));
    expect(adapter.crossfadeToPrepared).toHaveBeenCalledWith("test://stream/x", 4);
    expect(result.current.state.current?.id).toBe("x");
  });

  it("plays the picked track next when the current one ends before the pick commits", async () => {
    const { result, emit } = await setup();
    act(() => result.current.controls.play(t("a"), queue4()));
    act(() => {
      result.current.controls.playNext([t("x")]);
      emit("ended");
    });
    expect(ids(result.current.state.queue)).toEqual(["a", "x", "b", "c", "d"]);
    expect(result.current.state.current?.id).toBe("x");
    expect(result.current.state.index).toBe(1);

    // And a pick made before the advance commits goes after the new track.
    act(() => {
      emit("ended");
      result.current.controls.playNext([t("y")]);
    });
    expect(result.current.state.current?.id).toBe("b");
    expect(ids(result.current.state.queue)).toEqual(["a", "x", "b", "y", "c", "d"]);
    act(() => result.current.controls.next());
    expect(result.current.state.current?.id).toBe("y");
  });

  it("keeps its identity while the queue moves", async () => {
    const { result } = await setup();
    const playNext = result.current.controls.playNext;
    act(() => result.current.controls.play(t("a"), queue4()));
    act(() => result.current.controls.next());
    act(() => result.current.controls.playNext([t("x")]));
    expect(result.current.controls.playNext).toBe(playNext);
  });
});
