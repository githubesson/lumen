// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useRoutedPlayerControls,
  type RoutedPlayerControlsOptions,
} from "../src/player/use-routed-player-controls";
import type { PlayerControls } from "../src/player/player-core";
import type {
  PlaybackDevice,
  RemotePlaybackCommandResult,
} from "../src/player/activity-sync";
import type { TrackListItem } from "../src/api";

const track: TrackListItem = { id: "t1", title: "One", duration_ms: 1000 };
const second: TrackListItem = { ...track, id: "t2", title: "Two" };
const device: PlaybackDevice = {
  deviceId: "remote",
  deviceName: "Desktop",
  online: true,
  controlEnabled: true,
  capabilities: ["playback", "queue"],
  connectedAt: "",
  activity: {
    device_id: "remote",
    device_name: "Desktop",
    track_id: "t1",
    title: "One",
    position_sec: 0,
    is_playing: true,
    updated_at: "",
  },
};
const applied: RemotePlaybackCommandResult = {
  commandId: "c",
  sourceDeviceId: "local",
  targetDeviceId: "remote",
  status: "applied",
};

function setup(targetDevice: PlaybackDevice | null = null) {
  const controls: PlayerControls = {
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
  const options: RoutedPlayerControlsOptions = {
    controls,
    targetDevice,
    controlled: { volume: 0.4, muted: false, shuffle: false, repeat: "off" },
    sendCommand: vi.fn().mockResolvedValue(applied),
    remoteQueue: [track, second],
    canPlayLocally: vi.fn().mockReturnValue(true),
    onRemoteQueueApplied: vi.fn(),
  };
  const hook = renderHook(
    (props: RoutedPlayerControlsOptions) => useRoutedPlayerControls(props),
    { initialProps: options },
  );
  return { ...hook, options, controls };
}

describe("routed player controls", () => {
  it("delegates every local control and enforces the local play gate", () => {
    const { result, options, controls } = setup();
    for (const name of [
      "resume",
      "pause",
      "toggle",
      "next",
      "prev",
      "toggleMute",
      "toggleShuffle",
      "cycleRepeat",
    ] as const) {
      result.current[name]();
      expect(controls[name]).toHaveBeenCalledOnce();
    }
    result.current.play(track, [track]);
    expect(controls.play).toHaveBeenCalledWith(track, [track]);
    result.current.jumpTo(1);
    result.current.seek(12);
    result.current.setVolume(0.7);
    result.current.setMuted(true);
    result.current.setShuffle(true);
    result.current.setRepeat("one");
    expect(controls.jumpTo).toHaveBeenCalledWith(1);
    expect(controls.seek).toHaveBeenCalledWith(12);
    expect(controls.setVolume).toHaveBeenCalledWith(0.7);
    expect(controls.setMuted).toHaveBeenCalledWith(true);
    expect(controls.setShuffle).toHaveBeenCalledWith(true);
    expect(controls.setRepeat).toHaveBeenCalledWith("one");
    vi.mocked(options.canPlayLocally!).mockReturnValue(false);
    result.current.play(second);
    expect(controls.play).toHaveBeenCalledOnce();
    expect(options.sendCommand).not.toHaveBeenCalled();
  });

  it("routes remote commands without invoking local controls or offline feedback", async () => {
    const { result, options, controls } = setup(device);
    result.current.toggle();
    result.current.resume();
    result.current.pause();
    result.current.next();
    result.current.prev();
    result.current.seek(12);
    result.current.setVolume(5);
    result.current.setMuted(true);
    result.current.toggleMute();
    result.current.setShuffle(true);
    result.current.toggleShuffle();
    result.current.setRepeat("one");
    result.current.cycleRepeat();
    expect(vi.mocked(options.sendCommand).mock.calls).toEqual([
      ["set_playing", { playing: false }],
      ["set_playing", { playing: true }],
      ["set_playing", { playing: false }],
      ["next"],
      ["previous"],
      ["seek", { position_sec: 12 }],
      ["set_volume", { volume: 1 }],
      ["set_muted", { muted: true }],
      ["set_muted", { muted: true }],
      ["set_shuffle", { shuffle: true }],
      ["set_shuffle", { shuffle: true }],
      ["set_repeat", { repeat: "one" }],
      ["set_repeat", { repeat: "all" }],
    ]);
    await act(async () => result.current.play(track, [second]));
    expect(options.onRemoteQueueApplied).toHaveBeenCalledWith([track]);
    expect(options.canPlayLocally).not.toHaveBeenCalled();
    for (const control of Object.values(controls))
      expect(control).not.toHaveBeenCalled();
  });

  it("only adopts accepted queues and uses the remote queue for jumping", async () => {
    const { result, options } = setup(device);
    vi.mocked(options.sendCommand).mockResolvedValue({
      ...applied,
      status: "rejected",
    });
    await act(async () => result.current.play(track));
    expect(options.onRemoteQueueApplied).not.toHaveBeenCalled();
    vi.mocked(options.sendCommand).mockResolvedValue(applied);
    await act(async () => result.current.jumpTo(1));
    expect(options.sendCommand).toHaveBeenLastCalledWith(
      "play_track",
      expect.objectContaining({ track: expect.objectContaining({ id: "t2" }) }),
    );
    expect(options.onRemoteQueueApplied).toHaveBeenCalledWith([track, second]);
    vi.mocked(options.sendCommand).mockClear();
    result.current.jumpTo(99);
    expect(options.sendCommand).not.toHaveBeenCalled();
  });

  it("uses current toggle state and returns to local controls after deselection", () => {
    const { result, rerender, options, controls } = setup(device);
    rerender({
      ...options,
      controlled: {
        ...options.controlled,
        muted: true,
        shuffle: true,
        repeat: "one",
      },
    });
    result.current.toggleMute();
    result.current.toggleShuffle();
    result.current.cycleRepeat();
    expect(options.sendCommand).toHaveBeenCalledWith("set_muted", {
      muted: false,
    });
    expect(options.sendCommand).toHaveBeenCalledWith("set_shuffle", {
      shuffle: false,
    });
    expect(options.sendCommand).toHaveBeenCalledWith("set_repeat", {
      repeat: "off",
    });
    rerender({ ...options, targetDevice: null });
    result.current.toggle();
    expect(controls.toggle).toHaveBeenCalledOnce();
  });
});
