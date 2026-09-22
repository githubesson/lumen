import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioStatus } from "expo-audio";
import type { LogEntry } from "../lib/diagnostics/log";
import { createPlaybackDiagnostics, formatPlaybackTrace, playbackSnapshot } from "../lib/diagnostics/playback";

const { append } = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock("../lib/diagnostics/log", () => ({ diagnosticsLog: { append } }));

const status = (overrides: Partial<AudioStatus> = {}): AudioStatus => ({
  id: "native-player", currentTime: 0, duration: 180, playing: false,
  isLoaded: true, isBuffering: false, didJustFinish: false,
  timeControlStatus: "paused", reasonForWaitingToPlay: "unknown", error: null,
  ...overrides,
} as AudioStatus);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); append.mockClear(); });
afterEach(() => vi.useRealTimers());

describe("playback diagnostics", () => {
  it("keeps native errors and unexpected native strings out of the trace", () => {
    const secret = "https://audio.test/song?token=secret";
    const snapshot = playbackSnapshot(status({
      id: secret, error: secret, timeControlStatus: secret,
      reasonForWaitingToPlay: secret, currentTime: NaN, duration: Infinity,
    }));
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot).toMatchObject({ hasError: true, control: "unknown", waiting: "unknown", position: null, duration: null });
  });

  it("records both the queued event and the current native state", () => {
    const live = status({ playing: true, currentTime: 3, timeControlStatus: "playing" });
    const diagnostics = createPlaybackDiagnostics(() => live);
    diagnostics.observe(status(), false, false);
    const trace = JSON.parse(append.mock.calls[0][0].message);
    expect(trace.observed.playing).toBe(false);
    expect(trace.native.playing).toBe(true);
    expect(trace.native.position).toBe(3);
  });

  it("does not write every playback tick, but records a stalled start and recovery", () => {
    const live = status({ playing: true, timeControlStatus: "playing" });
    const diagnostics = createPlaybackDiagnostics(() => live);
    for (let second = 0; second < 60; second++) {
      vi.setSystemTime(second * 1000);
      live.currentTime = second;
      diagnostics.observe(live, false, false);
    }
    expect(append).toHaveBeenCalledTimes(1);
    for (let second = 60; second < 90; second++) {
      vi.setSystemTime(second * 1000);
      diagnostics.observe(live, false, false);
    }
    expect(append.mock.calls.map(([entry]) => entry.event)).toEqual(["audio-status", "audio-no-progress"]);
    live.currentTime = 60;
    diagnostics.observe(live, false, false);
    expect(append.mock.calls.at(-1)?.[0].event).toBe("audio-progress-resumed");
  });

  it("records an unloaded prepared source that never receives a play command", () => {
    const live = status({ isLoaded: false, duration: 0 });
    const diagnostics = createPlaybackDiagnostics(() => live);
    diagnostics.source("stream", true);
    diagnostics.observe(live, true, false);
    vi.setSystemTime(11_000);
    diagnostics.observe(live, true, false);
    expect(append.mock.calls.at(-1)?.[0].event).toBe("audio-no-progress");
    expect(JSON.parse(append.mock.calls.at(-1)![0].message)).toMatchObject({ generation: 1, pendingStart: true });
  });

  it("does not interfere with playback if the native object has been released", () => {
    const diagnostics = createPlaybackDiagnostics(() => { throw new Error("released"); });
    expect(() => diagnostics.record("audio-dispose")).not.toThrow();
    expect(append).not.toHaveBeenCalled();
  });

  it("exports playback and session records in time order without download data", () => {
    const entries = [
      { scope: "playback", at: 3, message: "pause" },
      { scope: "download", at: 2, url: "https://private.test/?token=secret" },
      { scope: "session", at: 1, message: "update identity" },
    ] as LogEntry[];
    const trace = formatPlaybackTrace(entries);
    expect(trace).not.toContain("secret");
    expect(trace.split("\n").map((line) => JSON.parse(line).at)).toEqual([1, 3]);
    expect(entries[0].at).toBe(3);
  });
});
