import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MARKS_BUSY_AFTER_MS,
  MARKS_GIVE_UP_AFTER_MS,
  useMarksWait,
  watchMarksWait,
  type MarksWait,
} from "../components/playlist-picker/marks-wait";

// Just enough React for the hook outside a renderer: one state cell, and
// effects that run when their deps change.
const hooks = vi.hoisted(() => ({
  state: undefined as unknown,
  deps: undefined as unknown[] | undefined,
  cleanup: undefined as (() => void) | void,
}));
vi.mock("react", () => ({
  useState: <T,>(initial: T) => {
    if (hooks.state === undefined) hooks.state = initial;
    return [
      hooks.state,
      (next: T | ((current: T) => T)) => {
        hooks.state =
          typeof next === "function" ? (next as (current: T) => T)(hooks.state as T) : next;
      },
    ];
  },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    if (hooks.deps && deps.every((dep, i) => Object.is(dep, hooks.deps![i]))) return;
    hooks.cleanup?.();
    hooks.deps = deps;
    hooks.cleanup = effect();
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  hooks.state = undefined;
  hooks.deps = undefined;
  hooks.cleanup = undefined;
});
afterEach(() => vi.useRealTimers());

describe("watchMarksWait", () => {
  it("shows the wait after a moment and lets go after a few seconds", () => {
    const phases: MarksWait[] = [];
    const stop = watchMarksWait((phase) => phases.push(phase));
    vi.advanceTimersByTime(MARKS_BUSY_AFTER_MS - 1);
    expect(phases).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(phases).toEqual(["busy"]);
    vi.advanceTimersByTime(MARKS_GIVE_UP_AFTER_MS - MARKS_BUSY_AFTER_MS);
    expect(phases).toEqual(["busy", "given-up"]);
    stop();
  });

  it("stops when cleaned up", () => {
    const onPhase = vi.fn();
    watchMarksWait(onPhase)();
    vi.advanceTimersByTime(MARKS_GIVE_UP_AFTER_MS);
    expect(onPhase).not.toHaveBeenCalled();
  });
});

describe("useMarksWait", () => {
  it("is quiet unless the marks are pending", () => {
    expect(useMarksWait(false)).toBe("quiet");
    vi.advanceTimersByTime(MARKS_GIVE_UP_AFTER_MS);
    expect(useMarksWait(false)).toBe("quiet");
  });

  it("never holds the rows again once it has let go", () => {
    expect(useMarksWait(true)).toBe("quiet");
    vi.advanceTimersByTime(MARKS_BUSY_AFTER_MS);
    expect(useMarksWait(true)).toBe("busy");
    vi.advanceTimersByTime(MARKS_GIVE_UP_AFTER_MS);
    expect(useMarksWait(true)).toBe("given-up");
    // Paused offline, then fetching again: the restarted timers don't go back.
    expect(useMarksWait(false)).toBe("quiet");
    expect(useMarksWait(true)).toBe("given-up");
    vi.advanceTimersByTime(MARKS_BUSY_AFTER_MS);
    expect(useMarksWait(true)).toBe("given-up");
  });
});
