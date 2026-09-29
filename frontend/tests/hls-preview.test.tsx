import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSnippetPreview } from "../src/components/share/useSnippetPreview";
import { useHtmlAudioAdapter } from "../src/adapters/html-audio-adapter";
import type { TrackDetail } from "../src/api";

const mock = vi.hoisted(() => ({ instances: [] as Array<{ config: unknown; startLoad: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> }));
vi.mock("hls.js/light", () => ({ default: class {
  static isSupported() { return true; }
  static Events = { ERROR: "error" };
  static ErrorTypes = {};
  config: unknown;
  startLoad = vi.fn();
  destroy = vi.fn();
  constructor(config: unknown) { this.config = config; mock.instances.push(this); }
  attachMedia() {}
  loadSource() {}
  on() {}
} }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); mock.instances = []; });

function silenceAudio(native: boolean) {
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(native ? "probably" : "");
}
it("starts HLS segment loading only when the share preview plays", async () => {
  silenceAudio(false);
  let preview!: ReturnType<typeof useSnippetPreview>;
  const track = { id: "tidal:track", source: "tidal" } as TrackDetail;
  function Preview({ open }: { open: boolean }) {
    const value = useSnippetPreview({ open, track, startSec: 10, endSec: 30 });
    useEffect(() => { preview = value; });
    return <audio ref={value.audioRef} />;
  }
  const { rerender } = render(<Preview open />);
  await act(async () => {});
  expect(mock.instances[0].config).toEqual({ autoStartLoad: false });
  expect(mock.instances[0].startLoad).not.toHaveBeenCalled();
  await act(async () => { await preview.togglePlay(); });
  expect(mock.instances[0].startLoad).toHaveBeenCalledWith(10);
  rerender(<Preview open={false} />);
  expect(mock.instances[0].destroy).toHaveBeenCalled();
});
it("uses native HLS for the current and prepared sources when available", () => {
  silenceAudio(true);
  let player!: ReturnType<typeof useHtmlAudioAdapter>;
  function Player() {
    const value = useHtmlAudioAdapter();
    useEffect(() => { player = value; });
    return <><audio ref={value.audioRefs[0]} /><audio ref={value.audioRefs[1]} /></>;
  }
  const { container } = render(<Player />);
  act(() => {
    player.adapter.load("/api/tracks/tidal%3Aone/stream");
    player.adapter.prepareNext?.("/api/tracks/tidal%3Atwo/stream");
  });
  expect(mock.instances).toHaveLength(0);
  expect(Array.from(container.querySelectorAll("audio")).map((audio) => audio.getAttribute("src"))).toEqual([
    "/api/tracks/tidal%3Aone/stream", "/api/tracks/tidal%3Atwo/stream",
  ]);
});
it("keeps hls.js in Chromium, which also reports native HLS support", async () => {
  silenceAudio(true);
  Object.defineProperty(navigator, "vendor", { value: "Google Inc.", configurable: true });
  try {
    let player!: ReturnType<typeof useHtmlAudioAdapter>;
    function Player() {
      const value = useHtmlAudioAdapter();
      useEffect(() => { player = value; });
      return <><audio ref={value.audioRefs[0]} /><audio ref={value.audioRefs[1]} /></>;
    }
    render(<Player />);
    await act(async () => {
      player.adapter.load("/api/tracks/tidal%3Aone/stream");
      await Promise.resolve();
    });
    await act(async () => {});
    expect(mock.instances).toHaveLength(1);
  } finally {
    delete (navigator as { vendor?: string }).vendor;
  }
});
