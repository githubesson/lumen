// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemotePlaybackControlEvent } from "../src/player/activity-sync";
import {
  REMOTE_CONTROL_INDICATOR_MS,
  useRemoteControlIndicator,
} from "../src/player/remote-control-indicator";

const mock = vi.hoisted(() => ({
  listeners: new Set<(event: RemotePlaybackControlEvent) => void>(),
}));

vi.mock("../src/player/activity-sync", () => ({
  subscribeRemotePlaybackControl: (listener: (event: RemotePlaybackControlEvent) => void) => {
    mock.listeners.add(listener);
    return () => mock.listeners.delete(listener);
  },
}));

const command = (commandId: string): RemotePlaybackControlEvent => ({
  commandId,
  sourceDeviceId: "phone",
  action: "next",
  controlledAt: 0,
});
const deliver = (event: RemotePlaybackControlEvent) => {
  for (const listener of mock.listeners) listener(event);
};

describe("useRemoteControlIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    mock.listeners.clear();
  });

  it("shows the latest command and hides it once the notice times out", () => {
    const { result } = renderHook(() => useRemoteControlIndicator());
    expect(result.current).toBeNull();
    act(() => deliver(command("c1")));
    expect(result.current?.commandId).toBe("c1");
    act(() => vi.advanceTimersByTime(REMOTE_CONTROL_INDICATOR_MS - 1));
    expect(result.current).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBeNull();
  });

  it("restarts the timer for each command in a burst", () => {
    const { result } = renderHook(() => useRemoteControlIndicator(1000));
    act(() => deliver(command("c1")));
    act(() => vi.advanceTimersByTime(800));
    act(() => deliver(command("c2")));
    act(() => vi.advanceTimersByTime(800));
    expect(result.current?.commandId).toBe("c2");
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBeNull();
  });

  it("unsubscribes and clears its timer on unmount", () => {
    const { unmount } = renderHook(() => useRemoteControlIndicator());
    act(() => deliver(command("c1")));
    unmount();
    expect(mock.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
