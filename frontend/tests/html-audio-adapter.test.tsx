import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHtmlAudioAdapter } from "../src/adapters/html-audio-adapter";

type FakeHls = {
  media: HTMLMediaElement | null;
  startLoad: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  fail: (data: object) => void;
};
const mock = vi.hoisted(() => ({ instances: [] as FakeHls[] }));
vi.mock("hls.js/light", () => ({ default: class {
  static isSupported() { return true; }
  static Events = { ERROR: "hlsError" };
  static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
  static ErrorDetails = {
    MANIFEST_LOAD_ERROR: "manifestLoadError",
    MANIFEST_LOAD_TIMEOUT: "manifestLoadTimeOut",
    MANIFEST_PARSING_ERROR: "manifestParsingError",
  };
  media: HTMLMediaElement | null = null;
  handler: ((event: string, data: object) => void) | null = null;
  startLoad = vi.fn();
  recoverMediaError = vi.fn();
  // Like hls.js, detaching empties the element.
  destroy = vi.fn(() => {
    this.media?.removeAttribute("src");
    this.media = null;
  });
  constructor() { mock.instances.push(this); }
  attachMedia(media: HTMLMediaElement) {
    this.media = media;
    media.src = "blob:hls";
  }
  loadSource() {}
  on(_event: string, handler: (event: string, data: object) => void) { this.handler = handler; }
  fail(data: object) { this.handler?.("hlsError", data); }
} }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); mock.instances = []; });

function setup() {
  // No native HLS, so TIDAL streams go through hls.js.
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
  let player!: ReturnType<typeof useHtmlAudioAdapter>;
  function Player() {
    const value = useHtmlAudioAdapter();
    useEffect(() => { player = value; });
    return <><audio ref={value.audioRefs[0]} /><audio ref={value.audioRefs[1]} /></>;
  }
  const { container } = render(<Player />);
  const [active, prepared] = Array.from(container.querySelectorAll("audio"));
  const error = vi.fn();
  player.adapter.on("error", error);
  return { adapter: player.adapter, active, prepared, error };
}

const manifestFailed = { fatal: true, type: "networkError", details: "manifestLoadError" };

it("reports a playlist hls.js gave up on, for the playing source only", async () => {
  const { adapter, active, prepared, error } = setup();
  act(() => adapter.load("/api/tracks/tidal%3Aone/stream"));
  await vi.waitFor(() => expect(mock.instances).toHaveLength(1));
  act(() => adapter.prepareNext?.("/api/tracks/tidal%3Atwo/stream"));
  await vi.waitFor(() => expect(mock.instances).toHaveLength(2));
  const current = mock.instances.find((hls) => hls.media === active)!;
  const next = mock.instances.find((hls) => hls.media === prepared)!;

  next.fail(manifestFailed);
  expect(next.destroy).toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();

  // A segment failure is still left to hls.js, and so is the media it drives.
  current.fail({ fatal: true, type: "networkError", details: "fragLoadError" });
  active.dispatchEvent(new Event("error"));
  expect(current.startLoad).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();

  current.fail(manifestFailed);
  expect(current.startLoad).toHaveBeenCalledOnce();
  expect(current.destroy).toHaveBeenCalled();
  expect(error).toHaveBeenCalledOnce();
});

it("reports a native media error on the playing element, but not on the prepared or an emptied one", async () => {
  const { adapter, active, prepared, error } = setup();
  act(() => {
    adapter.load("/api/tracks/one/stream");
    adapter.prepareNext?.("/api/tracks/two/stream");
  });

  prepared.dispatchEvent(new Event("error"));
  expect(error).not.toHaveBeenCalled();
  active.dispatchEvent(new Event("error"));
  expect(error).toHaveBeenCalledOnce();

  // load() empties both elements; the new stream waits on hls.js meanwhile.
  act(() => adapter.load("/api/tracks/tidal%3Athree/stream"));
  expect(active.hasAttribute("src")).toBe(false);
  active.dispatchEvent(new Event("error"));
  prepared.dispatchEvent(new Event("error"));
  expect(error).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(mock.instances).toHaveLength(1));
});

it("gives up on a playlist or segment the server refused", async () => {
  const { adapter, active, error } = setup();
  act(() => adapter.load("/api/tracks/tidal%3Aone/stream"));
  await vi.waitFor(() => expect(mock.instances).toHaveLength(1));
  const current = mock.instances.find((hls) => hls.media === active)!;

  // A server error may pass; an expired URL's 403 won't.
  current.fail({ fatal: true, type: "networkError", details: "fragLoadError", response: { code: 502, text: "" } });
  expect(current.startLoad).toHaveBeenCalledOnce();
  current.fail({ fatal: true, type: "networkError", details: "fragLoadError", response: { code: 403, text: "" } });
  expect(current.startLoad).toHaveBeenCalledOnce();
  expect(current.destroy).toHaveBeenCalled();
  expect(error).toHaveBeenCalledOnce();
});

it("says what the element or hls.js reported about the failure", async () => {
  const { adapter, active, error } = setup();
  act(() => adapter.load("/api/tracks/one/stream"));
  Object.defineProperty(active, "error", {
    configurable: true,
    value: { code: 4, message: "DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed" },
  });
  active.dispatchEvent(new Event("error"));
  expect(error).toHaveBeenCalledOnce();
  expect(adapter.errorDetail?.()).toBe(
    "MEDIA_ERR_SRC_NOT_SUPPORTED: DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed",
  );

  act(() => adapter.load("/api/tracks/tidal%3Atwo/stream"));
  await vi.waitFor(() => expect(mock.instances).toHaveLength(1));
  mock.instances[0].fail({
    ...manifestFailed,
    url: "https://cdn.example/signed?token=secret",
    error: new Error("A network error (status 502) occurred while loading manifest"),
  });
  expect(error).toHaveBeenCalledTimes(2);
  expect(adapter.errorDetail?.()).toBe(
    "hls.js manifestLoadError: A network error (status 502) occurred while loading manifest",
  );
});

// jsdom never plays an element; mark it playing for a crossfade to start.
function playing(audio: HTMLAudioElement) {
  Object.defineProperty(audio, "paused", { configurable: true, get: () => false });
}

describe("crossfadeToPrepared", () => {
  const one = "/api/tracks/one/stream";
  const two = "/api/tracks/two/stream";

  // `one` playing at 0.8, `two` prepared and buffered.
  function playingWithNextReady() {
    const player = setup();
    act(() => {
      player.adapter.setVolume(0.8);
      player.adapter.load(one);
      player.adapter.prepareNext?.(two);
    });
    Object.defineProperty(player.prepared, "readyState", {
      configurable: true,
      get: () => HTMLMediaElement.HAVE_ENOUGH_DATA,
    });
    playing(player.active);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    return player;
  }

  it("fades the next song in while this one fades out, then stops this one", () => {
    const { adapter, active, prepared } = playingWithNextReady();
    const ended = vi.fn();
    adapter.on("ended", ended);

    expect(adapter.crossfadeToPrepared?.(two, 4)).toBe(true);
    expect(prepared.volume).toBe(0);
    expect(active.volume).toBeCloseTo(0.8);
    expect(active.getAttribute("src")).toBe(one);

    vi.advanceTimersByTime(2000);
    expect(prepared.volume).toBeCloseTo(0.8 * Math.SQRT1_2);
    expect(active.volume).toBeCloseTo(0.8 * Math.SQRT1_2);
    // The outgoing song's events are no longer the player's.
    active.dispatchEvent(new Event("ended"));
    expect(ended).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(prepared.volume).toBeCloseTo(0.8);
    expect(active.hasAttribute("src")).toBe(false);
  });

  it("keeps a volume change in proportion mid-fade, and a pause ends the fade", () => {
    const { adapter, active, prepared } = playingWithNextReady();
    adapter.crossfadeToPrepared?.(two, 4);
    vi.advanceTimersByTime(1000);
    adapter.setVolume(0.4);
    expect(prepared.volume).toBeCloseTo(0.4 * Math.sin(Math.PI / 8));
    expect(active.volume).toBeCloseTo(0.4 * Math.cos(Math.PI / 8));

    adapter.pause();
    expect(active.hasAttribute("src")).toBe(false);
    expect(prepared.volume).toBeCloseTo(0.4);
  });

  it("ends the fade at once on a seek, a new source or disposal", () => {
    const seek = playingWithNextReady();
    seek.adapter.crossfadeToPrepared?.(two, 4);
    seek.adapter.seek(30);
    expect(seek.active.hasAttribute("src")).toBe(false);
    expect(seek.prepared.volume).toBeCloseTo(0.8);
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
    vi.useRealTimers();

    const load = playingWithNextReady();
    load.adapter.crossfadeToPrepared?.(two, 4);
    act(() => load.adapter.load("/api/tracks/three/stream"));
    expect(load.active.hasAttribute("src")).toBe(false);
    expect(load.prepared.getAttribute("src")).toBe("/api/tracks/three/stream");
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
    vi.useRealTimers();

    const dispose = playingWithNextReady();
    dispose.adapter.crossfadeToPrepared?.(two, 4);
    dispose.adapter.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the outgoing song's hls.js until its fade ends, then destroys it once", async () => {
    const { adapter, active, prepared } = setup();
    act(() => adapter.load("/api/tracks/tidal%3Aone/stream"));
    await vi.waitFor(() => expect(mock.instances).toHaveLength(1));
    act(() => adapter.prepareNext?.("/api/tracks/tidal%3Atwo/stream"));
    await vi.waitFor(() => expect(mock.instances).toHaveLength(2));
    await act(async () => {});
    const outgoing = mock.instances.find((hls) => hls.media === active)!;
    const incoming = mock.instances.find((hls) => hls.media === prepared)!;
    playing(active);
    Object.defineProperty(prepared, "readyState", {
      configurable: true,
      get: () => HTMLMediaElement.HAVE_ENOUGH_DATA,
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });

    expect(adapter.crossfadeToPrepared?.("/api/tracks/tidal%3Atwo/stream", 4)).toBe(true);
    vi.advanceTimersByTime(3900);
    expect(outgoing.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(outgoing.destroy).toHaveBeenCalledOnce();
    expect(incoming.destroy).not.toHaveBeenCalled();
    // The playing stream's fatal errors are still reported.
    const error = vi.fn();
    adapter.on("error", error);
    incoming.fail(manifestFailed);
    expect(error).toHaveBeenCalledOnce();
  });

  it("ends a fade before preparing the next song on the element it leaves", async () => {
    const { adapter, active, prepared } = setup();
    act(() => adapter.load("/api/tracks/tidal%3Aone/stream"));
    await vi.waitFor(() => expect(mock.instances).toHaveLength(1));
    act(() => adapter.prepareNext?.("/api/tracks/tidal%3Atwo/stream"));
    await vi.waitFor(() => expect(mock.instances).toHaveLength(2));
    await act(async () => {});
    const outgoing = mock.instances.find((hls) => hls.media === active)!;
    const incoming = mock.instances.find((hls) => hls.media === prepared)!;
    playing(active);
    Object.defineProperty(prepared, "readyState", {
      configurable: true,
      get: () => HTMLMediaElement.HAVE_ENOUGH_DATA,
    });
    expect(adapter.crossfadeToPrepared?.("/api/tracks/tidal%3Atwo/stream", 4)).toBe(true);

    act(() => adapter.prepareNext?.("/api/tracks/tidal%3Athree/stream"));
    expect(outgoing.destroy).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mock.instances).toHaveLength(3));
    expect(mock.instances[2].media).toBe(active);
    expect(incoming.destroy).not.toHaveBeenCalled();
    expect(prepared.volume).toBeCloseTo(1);
  });

  it("changes nothing when the next song isn't ready or can't take a volume, or nothing plays", () => {
    const { adapter, active, prepared } = playingWithNextReady();
    // The browser paused it: the timeupdate it sends with the pause comes
    // first, and must not start the next song.
    Object.defineProperty(active, "paused", { configurable: true, get: () => true });
    expect(adapter.crossfadeToPrepared?.(two, 4)).toBe(false);
    playing(active);

    Object.defineProperty(prepared, "readyState", { configurable: true, get: () => 0 });
    expect(adapter.crossfadeToPrepared?.(two, 4)).toBe(false);

    // iOS Safari: volume always reads 1.
    Object.defineProperty(prepared, "readyState", {
      configurable: true,
      get: () => HTMLMediaElement.HAVE_ENOUGH_DATA,
    });
    Object.defineProperty(prepared, "volume", { configurable: true, get: () => 1, set: () => {} });
    expect(adapter.crossfadeToPrepared?.(two, 4)).toBe(false);
    expect(active.volume).toBeCloseTo(0.8);
    expect(active.getAttribute("src")).toBe(one);
    expect(adapter.activatePrepared?.(two)).toBe(true);
  });
});
