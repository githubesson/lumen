// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocalDay } from "../src/replay/use-local-day";

afterEach(() => {
  vi.useRealTimers();
});

describe("useLocalDay", () => {
  it("moves to the next day just after local midnight", () => {
    vi.useFakeTimers({
      now: new Date(2026, 9, 2, 23, 59, 0),
      toFake: ["setTimeout", "clearTimeout", "Date"],
    });
    const { result } = renderHook(() => useLocalDay());
    expect(result.current).toBe(new Date(2026, 9, 2).toDateString());
    act(() => {
      vi.advanceTimersByTime(62_000);
    });
    expect(result.current).toBe(new Date(2026, 9, 3).toDateString());
    // And re-arms for the following midnight.
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });
    expect(result.current).toBe(new Date(2026, 9, 4).toDateString());
  });

  it("rechecks the date on resume, since timers stall while suspended", () => {
    vi.useFakeTimers({
      now: new Date(2026, 9, 2, 22),
      toFake: ["setTimeout", "clearTimeout", "Date"],
    });
    let resume: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((onResume: () => void) => {
      resume = onResume;
      return unsubscribe;
    });
    const { result, unmount } = renderHook(() => useLocalDay(subscribe));
    // Suspended past midnight without the timer firing.
    vi.setSystemTime(new Date(2026, 9, 3, 8));
    expect(result.current).toBe(new Date(2026, 9, 2).toDateString());
    act(() => resume?.());
    expect(result.current).toBe(new Date(2026, 9, 3).toDateString());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
