import { beforeEach, expect, it, vi } from "vitest";
import { useImageFailure } from "../lib/use-image-failure";

// Just enough React: state slots by call order that persist across calls.
const react = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const at = react.index++;
    if (!(at in react.slots)) react.slots[at] = initial;
    return [react.slots[at], (next: unknown) => (react.slots[at] = next)];
  },
  useCallback: (fn: unknown) => fn,
}));
const net = vi.hoisted(() => ({ offline: false }));
vi.mock("../lib/offline-mode", () => ({ useIsOffline: () => net.offline }));

// Starts a render: the next hook call reads the slots from the top.
const next = (uri: string | null) => {
  react.index = 0;
  return uri;
};

beforeEach(() => {
  react.slots = [];
  net.offline = false;
});

it("remembers a failure for the URL that failed", () => {
  useImageFailure(next("a")).onError();
  expect(useImageFailure(next("a")).failed).toBe(true);
});

it("tries again on another URL, and on coming back to the one that failed", () => {
  useImageFailure(next("a")).onError();
  expect(useImageFailure(next("a")).failed).toBe(true);
  expect(useImageFailure(next("b")).failed).toBe(false);
  expect(useImageFailure(next("a")).failed).toBe(false);
});

it("tries again when connectivity changes", () => {
  useImageFailure(next("a")).onError();
  net.offline = true;
  expect(useImageFailure(next("a")).failed).toBe(false);
});

it("never fails without a URL", () => {
  useImageFailure(next(null)).onError();
  expect(useImageFailure(next(null)).failed).toBe(false);
});
