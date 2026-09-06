// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api, setBaseUrl, type TrackListItem } from "../src/api";
import { usePlaybackActivityPublisher, usePlaybackRemoteSession } from "../src/player/activity-sync";
import { remotePlayerState, useRemotePlaybackCommands } from "../src/player/remote-control";
import type { PlayerControls, PlayerState } from "../src/player/player-core";
import type { AudioAdapter, AudioAdapterEvent } from "../src/player/audio-adapter";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen = () => {};
  onclose = () => {};
  onmessage = (_event: { data: string }) => {};
  sent: Array<Record<string, unknown>> = [];
  constructor() { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose(); }
  open() { this.readyState = 1; this.onopen(); }
  receive(message: object) { this.onmessage({ data: JSON.stringify({ protocol: 1, ...message }) }); }
  queue() {
    const update = this.sent.findLast((message) => message.type === "activity.update");
    return update?.queue as { revision: string; tracks: TrackListItem[]; index: number; offset: number; total: number; shuffle: boolean; repeat: "all" };
  }
}
const tracks = Array.from({ length: 120 }, (_, i) => ({ id: `t${i}`, title: `Track ${i}`, duration_ms: 1000 }));
const state: PlayerState = {
  queue: tracks, current: tracks[70], index: 70, isPlaying: true,
  volume: 0.5, muted: false, shuffle: false, repeat: "off",
};
const storage = { getItem: vi.fn().mockResolvedValue("local"), setItem: vi.fn(), removeItem: vi.fn() };
const time = { currentTime: 0, duration: 1 };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setBaseUrl("");
  Socket.instances = [];
});

async function setup(adapter?: Pick<AudioAdapter, "on" | "currentTime" | "duration">) {
  vi.stubGlobal("WebSocket", Socket);
  setBaseUrl("https://lumen.test");
  vi.spyOn(api, "upsertPlaybackActivity").mockResolvedValue(undefined as never);
  vi.spyOn(api, "clearPlaybackActivity").mockResolvedValue(undefined as never);
  const controls = Object.fromEntries([
    "play", "resume", "pause", "toggle", "next", "prev", "jumpTo", "seek",
    "setVolume", "setMuted", "toggleMute", "setShuffle", "toggleShuffle", "setRepeat", "cycleRepeat",
  ].map((key) => [key, vi.fn()])) as unknown as PlayerControls;
  const hook = renderHook((s: PlayerState) => {
    usePlaybackActivityPublisher({ state: s, time, storage, deviceName: "Test", controls, adapter });
    return usePlaybackRemoteSession();
  }, { initialProps: state });
  await act(async () => {});
  const socket = Socket.instances[0];
  act(() => socket.open());
  return { ...hook, socket, controls };
}

function liveClock() {
  const listeners = new Map<AudioAdapterEvent, () => void>();
  const clock = { currentTime: 45, duration: 300 };
  const adapter = {
    currentTime: () => clock.currentTime,
    duration: () => clock.duration,
    on(event: AudioAdapterEvent, listener: () => void) {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    },
  };
  return { clock, adapter, emit: (event: AudioAdapterEvent) => listeners.get(event)?.() };
}

it("publishes live audio time while the source UI clock is frozen, including reconnect", async () => {
  const { adapter, clock } = liveClock();
  const { socket } = await setup(adapter);
  expect(socket.sent.at(-1)).toMatchObject({ activity: { position_sec: 45, duration_sec: 300 } });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  act(() => socket.close());
  clock.currentTime = 65;
  act(() => vi.advanceTimersByTime(1000));
  const reconnected = Socket.instances[1];
  act(() => reconnected.open());
  expect(reconnected.sent.at(-1)).toMatchObject({ activity: { position_sec: 65 } });
});

it("publishes a completed seek before the UI has committed its new time", async () => {
  const { adapter, clock, emit } = liveClock();
  const { socket } = await setup(adapter);
  clock.currentTime = 120;
  act(() => emit("seeked"));
  expect(socket.sent.at(-1)).toMatchObject({ activity: { position_sec: 120, duration_sec: 300 } });
  clock.currentTime = 12;
  act(() => emit("seeked"));
  expect(socket.sent.at(-1)).toMatchObject({ activity: { position_sec: 12 } });
});

it("samples each heartbeat independently of paused rendering", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { adapter, clock } = liveClock();
  const { socket } = await setup(adapter);
  for (const seconds of [55, 65, 75]) {
    clock.currentTime = seconds;
    act(() => vi.advanceTimersByTime(10_000));
    expect(socket.sent.at(-1)).toMatchObject({ activity: { position_sec: seconds } });
  }
});

it("publishes actual queue order and advances the window immediately, including while paused", async () => {
  const { socket, rerender } = await setup();
  const original = socket.queue();
  expect(original).toMatchObject({ index: 24, offset: 46, total: 120, shuffle: false, repeat: "off" });
  expect(original.tracks).toHaveLength(50);
  expect(original.tracks[24].id).toBe("t70");
  rerender({ ...state, index: 71, current: tracks[71], isPlaying: false });
  expect(socket.queue()).toMatchObject({ index: 24, offset: 47, revision: original.revision });
  const shuffled = [...tracks].reverse();
  rerender({ ...state, queue: shuffled, index: 49, current: shuffled[49], shuffle: true, repeat: "all", isPlaying: false });
  expect(socket.queue().revision).not.toBe(original.revision);
  expect(socket.queue()).toMatchObject({ shuffle: true, repeat: "all" });
  expect(socket.queue().tracks[24].id).toBe("t70");
  rerender({ ...state, queue: [], current: null, index: 0, isPlaying: false });
  expect(socket.sent.at(-1)?.type).toBe("activity.clear");
});

it("reports rejected remote plays and preserves the result on duplicate delivery", async () => {
  const { socket, controls } = await setup();
  vi.mocked(controls.play).mockReturnValue(false);
  const command = {
    type: "playback.command", command_id: "offline-play", source_device_id: "phone",
    target_device_id: "local", action: "play_track",
    args: { track: tracks[0], queue: tracks.slice(0, 2) },
  };
  await act(async () => socket.receive(command));
  expect(controls.play).toHaveBeenCalledExactlyOnceWith(tracks[0], tracks.slice(0, 2));
  expect(socket.sent.at(-1)).toMatchObject({
    type: "playback.command_result", command_id: "offline-play",
    status: "rejected", error: "track is not available for local playback",
  });
  await act(async () => socket.receive(command));
  expect(controls.play).toHaveBeenCalledOnce();
  expect(socket.sent.at(-1)).toMatchObject({ status: "rejected" });

  vi.mocked(controls.play).mockReturnValue(undefined);
  await act(async () => socket.receive({ ...command, command_id: "online-play" }));
  expect(socket.sent.at(-1)).toMatchObject({ status: "applied" });
});

it("applies queue jumps by absolute index and rejects stale queue revisions", async () => {
  const { socket, controls, rerender } = await setup();
  const revision = socket.queue().revision;
  const command = {
    type: "playback.command", command_id: "jump-1", source_device_id: "phone",
    target_device_id: "local", action: "jump_to",
    args: { index: 71, track_id: "t71", queue_revision: revision },
  };
  await act(async () => socket.receive(command));
  expect(controls.jumpTo).toHaveBeenCalledExactlyOnceWith(71);
  expect(socket.sent.at(-1)).toMatchObject({ type: "playback.command_result", status: "applied" });
  await act(async () => socket.receive(command));
  expect(controls.jumpTo).toHaveBeenCalledOnce();
  rerender({ ...state, queue: [...tracks].reverse(), index: 49 });
  await act(async () => socket.receive({ ...command, command_id: "jump-2" }));
  expect(socket.sent.at(-1)).toMatchObject({ status: "rejected" });
  expect(controls.jumpTo).toHaveBeenCalledOnce();
  expect(controls.play).not.toHaveBeenCalled();
});

it("adopts queues from device snapshots and reconciles shuffle and repeat", async () => {
  const { socket, result } = await setup();
  const queue = { ...socket.queue(), shuffle: true, repeat: "all" as const };
  const activity = {
    device_id: "desktop", device_name: "Desktop", track_id: "t70", title: "Track 70",
    position_sec: 0, is_playing: true, updated_at: new Date().toISOString(),
  };
  act(() => socket.receive({ type: "devices.snapshot", devices: [{
    device_id: "desktop", device_name: "Desktop", online: true, control_enabled: true,
    capabilities: ["queue"], connected_at: "", activity, queue,
  }] }));
  const device = result.current.devices[0];
  expect(device.queue).toEqual(queue);
  const { result: remote } = renderHook(() => useRemotePlaybackCommands({
    targetDeviceId: device.deviceId, sourceDeviceId: "local", targetActivity: device.activity,
    targetQueue: device.queue, initialState: { volume: 0.5, muted: false, shuffle: false, repeat: "off" },
  }));
  expect(remote.current.controlled).toMatchObject({ shuffle: true, repeat: "all" });
  expect(remotePlayerState(device, remote.current.controlled)).toMatchObject({
    queue: queue.tracks, index: 24, current: tracks[70], shuffle: true, repeat: "all",
  });
  act(() => socket.close());
  expect(result.current.devices).toEqual([]);
});

it("republishes its queue after a socket reconnect", async () => {
  const { socket } = await setup();
  const queue = socket.queue();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  act(() => socket.close());
  act(() => vi.advanceTimersByTime(1000));
  const reconnected = Socket.instances[1];
  act(() => reconnected.open());
  expect(reconnected.queue()).toEqual(queue);
});

it.each([0, 60, 119])("bounds UTF-8 activity frames while retaining queue position %i, including reconnect", async (index) => {
  const { socket, rerender } = await setup();
  // Each title is valid at the server's 1,000-byte limit. The multilingual
  // metadata and escaped characters push the original 50-track frame past 64 KiB.
  const largeTracks = tracks.map((track) => ({
    ...track, title: "音".repeat(300), artist: "🎵".repeat(200),
    album_title: '"\\\n'.repeat(120), aka: "a".repeat(1000),
  }));
  rerender({ ...state, queue: largeTracks, current: largeTracks[index], index });
  const queue = socket.queue();
  const update = socket.sent.at(-1)!;
  const bytes = (value: unknown) => new Blob([JSON.stringify(value)]).size;
  expect(bytes({ ...update, queue: { ...queue, tracks: largeTracks.slice(0, 50) } })).toBeGreaterThan(65_536);
  expect(bytes(update)).toBeLessThanOrEqual(65_536);
  expect(queue.tracks.length).toBeLessThan(50);
  expect(queue.tracks[queue.index]).toEqual(largeTracks[index]);
  expect(queue.offset + queue.index).toBe(index);
  expect(queue.tracks.map((track) => track.id)).toEqual(
    largeTracks.slice(queue.offset, queue.offset + queue.tracks.length).map((track) => track.id),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  act(() => socket.close());
  act(() => vi.advanceTimersByTime(1000));
  const reconnected = Socket.instances[1];
  act(() => reconnected.open());
  expect(reconnected.queue()).toEqual(queue);
  for (const frame of reconnected.sent) expect(bytes(frame)).toBeLessThanOrEqual(65_536);
});

it("keeps a minimal current track when its optional metadata alone exceeds the byte limit", async () => {
  const { socket, rerender } = await setup();
  const largeTracks = tracks.map((track) => ({ ...track, aka: "x".repeat(70_000) }));
  rerender({ ...state, queue: largeTracks, current: largeTracks[70] });
  expect(socket.queue()).toMatchObject({ tracks: [tracks[70]], index: 0, offset: 70, total: 120 });
  expect(new Blob([JSON.stringify(socket.sent.at(-1))]).size).toBeLessThanOrEqual(65_536);
});

it("does not send an oversized frame even when the activity envelope itself is too large", async () => {
  const { socket, rerender } = await setup();
  socket.sent = [];
  const largeTracks = tracks.map((track) => ({ ...track, artist: "x".repeat(70_000) }));
  rerender({ ...state, queue: largeTracks, current: largeTracks[70] });
  expect(socket.sent).toEqual([]);
  expect(api.upsertPlaybackActivity).toHaveBeenLastCalledWith(expect.objectContaining({ track_id: "t70" }));
});
