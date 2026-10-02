import { afterEach, describe, expect, it, vi } from "vitest";
import { replayRequest } from "@music-library/core";
import { subscribeAppActive } from "../lib/app-resume";
import { qk } from "../lib/query-keys";

const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    listeners,
    addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    }),
  };
});
// Hoisted above the imports by vitest.
vi.mock("react-native", () => ({ AppState: appState }));

afterEach(() => {
  vi.useRealTimers();
  appState.listeners.clear();
});

describe("Replay query key", () => {
  it("changes when a rolling period moves into a new window", () => {
    // The key is persisted to disk, so a key on the period's name alone let
    // September's "this month" answer for October after the boundary.
    vi.useFakeTimers({ now: new Date(2026, 8, 30, 12) });
    const september = qk.replay(replayRequest({ kind: "this-month" }).cacheKey);
    vi.setSystemTime(new Date(2026, 9, 1, 12));
    const october = qk.replay(replayRequest({ kind: "this-month" }).cacheKey);
    expect(september).not.toEqual(october);
    expect(october[0]).toBe("replay");
  });

  it("keeps the home shelf and the Replay screen on one last-30-days entry", () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 2, 9)) });
    const home = qk.replay(replayRequest({ kind: "last-30" }).cacheKey);
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 2, 10)));
    const screen = qk.replay(replayRequest({ kind: "last-30" }).cacheKey);
    expect(home).toEqual(screen);
  });
});

describe("subscribeAppActive", () => {
  it("reports returns to the foreground only, until unsubscribed", () => {
    const onResume = vi.fn();
    const unsubscribe = subscribeAppActive(onResume);
    const emit = (state: string) => appState.listeners.forEach((l) => l(state));
    emit("background");
    emit("inactive");
    expect(onResume).not.toHaveBeenCalled();
    emit("active");
    expect(onResume).toHaveBeenCalledTimes(1);
    unsubscribe();
    emit("active");
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
