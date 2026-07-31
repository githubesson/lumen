// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackActivity } from "../src/api";
import { useRemoteActivityClock } from "../src/player/remote-control";

const activity = (over: Partial<PlaybackActivity> = {}): PlaybackActivity => ({
  device_id: "mac",
  device_name: "Mac",
  track_id: "t1",
  title: "Track 1",
  duration_sec: 200,
  position_sec: 10,
  is_playing: true,
  updated_at: new Date(Date.now()).toISOString(),
  ...over,
});

describe("useRemoteActivityClock", () => {
  beforeEach(() => {
    // Restricted to what the hook uses so React's own scheduling stays real.
    vi.useFakeTimers({
      now: new Date("2026-07-31T12:00:00Z"),
      toFake: ["setInterval", "clearInterval", "Date"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extrapolates a playing target's position between heartbeats", () => {
    const heartbeat = activity();
    const { result } = renderHook(() => useRemoteActivityClock(heartbeat));
    expect(result.current).toEqual({ currentTime: 10, duration: 200 });

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.currentTime).toBeCloseTo(11, 1);

    act(() => vi.advanceTimersByTime(4000));
    expect(result.current.currentTime).toBeCloseTo(15, 1);
  });

  it("holds a paused target at its reported position", () => {
    const heartbeat = activity({ is_playing: false });
    const { result } = renderHook(() => useRemoteActivityClock(heartbeat));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toEqual({ currentTime: 10, duration: 200 });
  });

  it("re-reads the position when a new heartbeat arrives", () => {
    const { result, rerender } = renderHook(
      ({ a }: { a: PlaybackActivity }) => useRemoteActivityClock(a),
      { initialProps: { a: activity() } },
    );
    act(() => vi.advanceTimersByTime(2000));

    // The next heartbeat reports a seek back to 4s.
    rerender({
      a: activity({
        position_sec: 4,
        updated_at: new Date(Date.now()).toISOString(),
      }),
    });
    expect(result.current.currentTime).toBeCloseTo(4, 1);
  });

  it("does not tick when disabled, but still adopts the heartbeat", () => {
    const heartbeat = activity();
    const { result } = renderHook(() => useRemoteActivityClock(heartbeat, false));
    expect(result.current).toEqual({ currentTime: 10, duration: 200 });
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toEqual({ currentTime: 10, duration: 200 });
  });

  it("reports zeros for an absent target", () => {
    const { result } = renderHook(() => useRemoteActivityClock(undefined));
    expect(result.current).toEqual({ currentTime: 0, duration: 0 });
  });

  it("reaches a fixed point when the caller passes a fresh object every render", () => {
    // A caller that builds the activity inline re-runs the sync effect on
    // every render; the bailout in setTime must terminate the feedback loop.
    const { result } = renderHook(() => useRemoteActivityClock(activity()));
    expect(result.current).toEqual({ currentTime: 10, duration: 200 });
  });

  it("clamps extrapolation to the track duration", () => {
    const heartbeat = activity({ position_sec: 199 });
    const { result } = renderHook(() => useRemoteActivityClock(heartbeat));
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.currentTime).toBe(200);
  });
});
