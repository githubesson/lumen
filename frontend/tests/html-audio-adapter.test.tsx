import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); mock.instances = []; });

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
