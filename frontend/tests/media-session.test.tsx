import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerControls, TrackListItem } from "@music-library/core";
import { useMediaSession } from "../src/lib/useMediaSession";

type Handler = ((details: { seekTime?: number }) => void) | null;

const handlers = new Map<string, Handler>();
const session = {
  metadata: null as unknown,
  setActionHandler: (action: string, handler: Handler) => {
    handlers.set(action, handler);
  },
};

class FakeMediaMetadata {
  constructor(init: Record<string, unknown>) {
    Object.assign(this, init);
  }
}

const track: TrackListItem = {
  id: "t1",
  title: "Song",
  artist: "Artist",
  album_id: "al1",
  album_title: "Album",
  duration_ms: 1000,
};

function controls(): Pick<PlayerControls, "toggle" | "prev" | "next" | "seek"> {
  return { toggle: vi.fn(), prev: vi.fn(), next: vi.fn(), seek: vi.fn() };
}

beforeEach(() => {
  handlers.clear();
  session.metadata = null;
  Object.defineProperty(navigator, "mediaSession", { value: session, configurable: true });
  vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaSession");
});

describe("useMediaSession", () => {
  it("publishes the local track with its artwork and routes OS buttons to it", () => {
    const local = controls();
    renderHook(() =>
      useMediaSession({ track, playing: false, controls: local, casting: false }),
    );
    expect(session.metadata).toMatchObject({ title: "Song", artist: "Artist", album: "Album" });
    const artwork = (session.metadata as { artwork: { src: string }[] }).artwork;
    expect(artwork[0]?.src).toContain("al1");
    handlers.get("play")?.({});
    expect(local.toggle).toHaveBeenCalledOnce();
    handlers.get("pause")?.({});
    expect(local.toggle).toHaveBeenCalledOnce();
    handlers.get("seekto")?.({ seekTime: 12 });
    expect(local.seek).toHaveBeenCalledWith(12);
  });

  it("omits a missing artist and album instead of publishing empty strings", () => {
    renderHook(() =>
      useMediaSession({
        track: { ...track, artist: undefined, album_title: undefined },
        playing: true,
        controls: controls(),
        casting: false,
      }),
    );
    expect(session.metadata).not.toHaveProperty("artist", "");
    expect((session.metadata as { artist?: string }).artist).toBeUndefined();
  });

  it("withdraws the session while casting, and keeps OS play from starting local audio", () => {
    const local = controls();
    const { rerender } = renderHook(
      ({ casting }: { casting: boolean }) =>
        useMediaSession({ track, playing: false, controls: local, casting }),
      { initialProps: { casting: false } },
    );
    rerender({ casting: true });
    expect(session.metadata).toBeNull();
    for (const action of ["pause", "previoustrack", "nexttrack", "seekto"]) {
      expect(handlers.get(action)).toBeNull();
    }
    // A registered no-op, not null: with no handler the browser's default
    // "play" resumes the paused <audio> element.
    const play = handlers.get("play");
    expect(play).toBeTypeOf("function");
    play?.({});
    expect(local.toggle).not.toHaveBeenCalled();

    rerender({ casting: false });
    expect(session.metadata).toMatchObject({ title: "Song" });
  });

  it("clears everything with nothing loaded", () => {
    renderHook(() =>
      useMediaSession({ track: null, playing: false, controls: controls(), casting: false }),
    );
    expect(session.metadata).toBeNull();
    expect(handlers.get("play")).toBeNull();
  });
});
