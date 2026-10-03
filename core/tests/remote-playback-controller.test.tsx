// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackActivity, TrackListItem } from "../src/api";
import type {
  PlaybackDevice,
  PlaybackRemoteSessionSnapshot,
} from "../src/player/activity-sync";
import type { PlayerControls, PlayerState, TimeState } from "../src/player/player-core";
import {
  useRemotePlaybackController,
  type UseRemotePlaybackControllerOptions,
} from "../src/player/use-remote-playback-controller";

const mock = vi.hoisted(() => ({
  session: null as unknown as PlaybackRemoteSessionSnapshot,
  send: vi.fn(),
}));

vi.mock("../src/player/activity-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/player/activity-sync")>()),
  usePlaybackRemoteSession: () => mock.session,
  sendRemotePlaybackCommand: mock.send,
}));

const track: TrackListItem = { id: "t1", title: "One", duration_ms: 200_000 };
const activity = (over: Partial<PlaybackActivity> = {}): PlaybackActivity => ({
  device_id: "desktop",
  device_name: "Desktop",
  track_id: "t1",
  title: "One",
  duration_sec: 200,
  position_sec: 10,
  is_playing: true,
  updated_at: new Date(Date.now()).toISOString(),
  volume: 0.25,
  ...over,
});
const device = (over: Partial<PlaybackDevice> = {}): PlaybackDevice => ({
  deviceId: "desktop",
  deviceName: "Desktop",
  online: true,
  controlEnabled: true,
  capabilities: ["playback", "queue"],
  connectedAt: "",
  activity: activity(),
  ...over,
});
const localState: PlayerState = {
  current: track,
  queue: [track],
  index: 0,
  isPlaying: true,
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: "off",
  playbackError: null,
};
const localTime: TimeState = { currentTime: 42, duration: 200 };

function controls(): PlayerControls {
  return {
    play: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    toggle: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    jumpTo: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    toggleMute: vi.fn(),
    setShuffle: vi.fn(),
    toggleShuffle: vi.fn(),
    setRepeat: vi.fn(),
    cycleRepeat: vi.fn(),
  };
}

function setup(target: PlaybackDevice = device()) {
  mock.session = {
    deviceId: "phone",
    connected: true,
    devicesReady: true,
    devices: [target],
  };
  const options: UseRemotePlaybackControllerOptions = {
    state: localState,
    controls: controls(),
    time: localTime,
  };
  const hook = renderHook(
    (props: UseRemotePlaybackControllerOptions) => useRemotePlaybackController(props),
    { initialProps: options },
  );
  return { ...hook, options };
}

beforeEach(() => {
  mock.send.mockReset();
  mock.send.mockImplementation(async (targetDeviceId: string) => ({
    commandId: "c",
    sourceDeviceId: "phone",
    targetDeviceId,
    status: "applied",
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useRemotePlaybackController", () => {
  it("shows the local player until a target is selected", () => {
    const { result, options } = setup();
    expect(result.current.displayedState).toBe(localState);
    expect(result.current.displayedTime).toBe(localTime);
    expect(result.current.remote.targetDevice).toBeNull();
    result.current.controls.next();
    expect(options.controls.next).toHaveBeenCalledOnce();
  });

  it("pauses local audio, seeds the target's state and routes controls on selection", () => {
    const { result, options } = setup();
    act(() => result.current.remote.selectTarget("desktop"));
    expect(options.controls.pause).toHaveBeenCalledOnce();
    expect(result.current.remote.targetDeviceId).toBe("desktop");
    expect(result.current.displayedState.current?.id).toBe("t1");
    // The target's own volume, not the local player's.
    expect(result.current.displayedState.volume).toBe(0.25);
    expect(result.current.displayedTime.currentTime).toBe(10);
    result.current.controls.next();
    expect(options.controls.next).not.toHaveBeenCalled();
    expect(mock.send).toHaveBeenCalledWith("desktop", "next", {});
  });

  it("keeps selectTarget and the remote value stable while local playback state moves", () => {
    const { result, rerender, options } = setup();
    const { remote } = result.current;
    rerender({ ...options, state: { ...localState, volume: 0.3, isPlaying: false } });
    rerender({ ...options, state: { ...localState, shuffle: true, repeat: "all", muted: true } });
    expect(result.current.remote).toBe(remote);
    expect(result.current.remote.selectTarget).toBe(remote.selectTarget);
  });

  it("selectTarget reads the latest local state despite its stable identity", () => {
    const { result, rerender, options } = setup();
    rerender({ ...options, state: { ...localState, isPlaying: false } });
    act(() => result.current.remote.selectTarget("desktop"));
    expect(options.controls.pause).not.toHaveBeenCalled();
  });

  it("ignores a jump on a target without a queue snapshot instead of replacing its queue", () => {
    const { result } = setup();
    act(() => result.current.remote.selectTarget("desktop"));
    expect(result.current.displayedState.queue).toHaveLength(1);
    act(() => result.current.controls.jumpTo(0));
    expect(mock.send).not.toHaveBeenCalled();
  });

  it("jumps by absolute position within a target's snapshot window", () => {
    const { result } = setup(
      device({
        queue: {
          revision: "r1",
          tracks: [track, { ...track, id: "t2" }],
          index: 0,
          offset: 30,
          total: 90,
          shuffle: false,
          repeat: "off",
        },
      }),
    );
    act(() => result.current.remote.selectTarget("desktop"));
    act(() => result.current.controls.jumpTo(1));
    expect(mock.send).toHaveBeenCalledWith("desktop", "jump_to", {
      index: 31,
      track_id: "t2",
      queue_revision: "r1",
    });
  });

  it("stops ticking the target's clock while it can't be seen", () => {
    vi.useFakeTimers({
      now: new Date("2026-07-31T12:00:00Z"),
      toFake: ["setInterval", "clearInterval", "Date"],
    });
    const { result, rerender, options } = setup();
    act(() => result.current.remote.selectTarget("desktop"));
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.displayedTime.currentTime).toBeCloseTo(12, 1);

    rerender({ ...options, clockEnabled: false });
    const hidden = result.current.displayedTime.currentTime;
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.displayedTime.currentTime).toBe(hidden);

    // Re-read from the heartbeat when visible again: 7s after it was sent.
    rerender({ ...options, clockEnabled: true });
    expect(result.current.displayedTime.currentTime).toBeCloseTo(17, 1);
  });
});
