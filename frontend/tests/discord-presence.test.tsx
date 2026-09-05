import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybackActivity, PlaybackDevice, TrackListItem } from "@music-library/core";
import { useDiscordPresence } from "../src/lib/discordPresence";

const mock = vi.hoisted(() => ({
  player: { current: null as TrackListItem | null, isPlaying: false },
  target: null as PlaybackDevice | null,
  latest: null as PlaybackActivity | null,
  listener: null as ((activity: PlaybackActivity | null) => void) | null,
  events: new Map<string, () => void>(),
  elapsed: vi.fn(() => 7),
  duration: vi.fn(() => 500),
  push: vi.fn(),
  clear: vi.fn(),
  sign: vi.fn(),
}));
vi.mock("@music-library/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@music-library/core")>(),
  getLatestPlaybackActivity: () => mock.latest,
  subscribePlaybackActivity: (listener: typeof mock.listener) => {
    mock.listener = listener;
    return () => { mock.listener = null; };
  },
}));
vi.mock("../src/api", () => ({ signAlbumCoverUrl: mock.sign }));
vi.mock("../src/lib/platform", () => ({
  isElectron: () => true, pushDiscordActivity: mock.push, clearDiscordActivity: mock.clear,
}));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => mock.player,
  useRemotePlayback: () => ({ targetDevice: mock.target }),
  usePlayerAdapter: () => adapter,
}));
const adapter = {
  currentTime: mock.elapsed,
  duration: mock.duration,
  on: (event: string, listener: () => void) => {
    mock.events.set(event, listener);
    return () => { mock.events.delete(event); };
  },
};
const now = new Date("2026-09-05T20:00:00Z");
const remote: PlaybackDevice = {
  deviceId: "phone", deviceName: "Phone", online: true, controlEnabled: true,
  connectedAt: "", capabilities: ["playback", "queue"],
  activity: {
    device_id: "phone", device_name: "Phone", track_id: "remote-track", title: "Remote",
    duration_sec: 300, position_sec: 120, is_playing: true,
    updated_at: new Date(now.getTime() - 5000).toISOString(),
  },
};
const local: TrackListItem = { id: "local-track", title: "Local", duration_ms: 500000 };

function select(device: PlaybackDevice | null) {
  mock.target = device;
  mock.player = device ? {
    current: device.activity ? { id: device.activity.track_id, title: device.activity.title, duration_ms: 300000 } : null,
    isPlaying: !!device.activity?.is_playing,
  } : { current: local, isPlaying: false };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now });
  vi.clearAllMocks();
  mock.elapsed.mockReturnValue(7);
  mock.duration.mockReturnValue(500);
  mock.sign.mockResolvedValue({ url: "https://covers.test/signed", expires_at: now.getTime() / 1000 + 3600 });
  mock.latest = null;
  select(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("uses the selected remote clock through fresh snapshots and pause/resume, without reading local audio", async () => {
  select(remote);
  const { rerender } = renderHook(() => useDiscordPresence());
  await act(async () => {});
  expect(mock.push).toHaveBeenLastCalledWith(expect.objectContaining({
    trackId: "remote-track", elapsedSec: 125, durationSec: 300, isPlaying: true,
  }));
  select({ ...remote, activity: { ...remote.activity!, position_sec: 140 } });
  rerender();
  await act(async () => {});
  expect(mock.push).toHaveBeenLastCalledWith(expect.objectContaining({ elapsedSec: 145 }));
  select({ ...remote, activity: { ...remote.activity!, position_sec: 145, is_playing: false } });
  rerender();
  await act(async () => {});
  expect(mock.push).toHaveBeenLastCalledWith(expect.objectContaining({ elapsedSec: 145, isPlaying: false }));
  select({ ...remote, activity: { ...remote.activity!, position_sec: 145, updated_at: now.toISOString() } });
  rerender();
  await act(async () => {});
  expect(mock.push).toHaveBeenLastCalledWith(expect.objectContaining({ elapsedSec: 145, isPlaying: true }));
  expect(mock.elapsed).not.toHaveBeenCalled();
  expect(mock.duration).not.toHaveBeenCalled();
});

it("ignores local adapter events and other devices while a remote target is selected", async () => {
  select(remote);
  renderHook(() => useDiscordPresence());
  await act(async () => {});
  mock.push.mockClear();
  await act(async () => {
    for (const listener of mock.events.values()) listener();
    mock.listener?.({ ...remote.activity!, track_id: "other-device-track", device_id: "other-device" });
    mock.listener?.(null);
  });
  expect(mock.push).not.toHaveBeenCalled();
  expect(mock.elapsed).not.toHaveBeenCalled();
  expect(mock.clear).not.toHaveBeenCalled();
});

it("clears an empty selected device and returns to local adapter timing after deselection", async () => {
  select(remote);
  const { rerender } = renderHook(() => useDiscordPresence());
  await act(async () => {});
  mock.latest = remote.activity;
  select({ ...remote, activity: null });
  rerender();
  await act(async () => {});
  expect(mock.clear).toHaveBeenCalledOnce();
  mock.latest = null;
  select(null);
  rerender();
  await act(async () => {});
  mock.elapsed.mockReturnValue(42);
  await act(async () => mock.events.get("seeked")?.());
  expect(mock.push).toHaveBeenLastCalledWith(expect.objectContaining({
    trackId: "local-track", durationSec: 500, elapsedSec: 42, isPlaying: false,
  }));
});

it("keeps playing local audio authoritative and still mirrors remote playback when local audio is paused", async () => {
  mock.player = { current: local, isPlaying: true };
  renderHook(() => useDiscordPresence());
  await act(async () => {});
  mock.push.mockClear();
  await act(async () => mock.listener?.(remote.activity));
  expect(mock.push).not.toHaveBeenCalled();
  mock.latest = remote.activity;
  await act(async () => mock.events.get("pause")?.());
  expect(mock.push).toHaveBeenLastCalledWith(expect.objectContaining({ trackId: "remote-track", elapsedSec: 125 }));
});

it("discards remote artwork results from a previously selected device", async () => {
  let resolveCover!: (value: { url: string; expires_at: number }) => void;
  mock.sign.mockReturnValueOnce(new Promise((resolve) => { resolveCover = resolve; }));
  select({ ...remote, activity: { ...remote.activity!, album_id: "album" } });
  const { rerender } = renderHook(() => useDiscordPresence());
  await act(async () => {});
  select({ ...remote, deviceId: "second", activity: { ...remote.activity!, device_id: "second", track_id: "second-track" } });
  rerender();
  await act(async () => {});
  expect(mock.push).toHaveBeenLastCalledWith(expect.objectContaining({ trackId: "second-track" }));
  mock.push.mockClear();
  await act(async () => resolveCover({ url: "https://covers.test/old", expires_at: now.getTime() / 1000 + 3600 }));
  expect(mock.push).not.toHaveBeenCalled();
});
