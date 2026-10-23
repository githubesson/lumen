import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PeekCandidate } from "../lib/swipe-peek";

const env = vi.hoisted(() => ({
  stored: new Map<string, string>(),
  reduceMotion: false,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => env.stored.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      env.stored.set(key, value);
    },
  },
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { isReduceMotionEnabled: async () => env.reduceMotion },
  Dimensions: { get: () => ({ height: 800 }) },
}));

// Module state (once per install), so each test loads it fresh.
async function load() {
  vi.resetModules();
  return import("../lib/swipe-peek");
}

function row(y: number | null) {
  const candidate = {
    y,
    peek: vi.fn(),
    measure: (done: Parameters<PeekCandidate["measure"]>[0]) =>
      done(candidate.y === null ? null : { y: candidate.y, height: 56 }),
  };
  return candidate;
}

beforeEach(() => {
  vi.useFakeTimers();
  env.stored.clear();
  env.reduceMotion = false;
});
afterEach(() => {
  vi.useRealTimers();
});

it("peeks the topmost row of a settled list once, and remembers", async () => {
  const { offerPeek } = await load();
  const rows = [row(300), row(244), row(356)];
  for (const r of rows) offerPeek(r);
  await vi.advanceTimersByTimeAsync(800);
  expect(rows[1].peek).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  expect(rows[1].peek).toHaveBeenCalledOnce();
  expect(rows[0].peek).not.toHaveBeenCalled();
  expect(env.stored.get("swipe-actions.peek-shown.v1")).toBe("1");

  // Later lists don't.
  const later = [row(100), row(156), row(212)];
  for (const r of later) offerPeek(r);
  await vi.advanceTimersByTimeAsync(2000);
  expect(later[0].peek).not.toHaveBeenCalled();
});

it("skips it once shown, and under Reduce Motion", async () => {
  env.stored.set("swipe-actions.peek-shown.v1", "1");
  let { offerPeek } = await load();
  let rows = [row(100), row(156), row(212)];
  for (const r of rows) offerPeek(r);
  await vi.advanceTimersByTimeAsync(2000);
  expect(rows[0].peek).not.toHaveBeenCalled();

  env.stored.clear();
  env.reduceMotion = true;
  ({ offerPeek } = await load());
  rows = [row(100), row(156), row(212)];
  for (const r of rows) offerPeek(r);
  await vi.advanceTimersByTimeAsync(2000);
  expect(rows[0].peek).not.toHaveBeenCalled();
  expect(env.stored.has("swipe-actions.peek-shown.v1")).toBe(false);
});

it("waits for a list with three rows on screen", async () => {
  const { offerPeek } = await load();
  const short = [row(100), row(156), row(900), row(null)];
  for (const r of short) offerPeek(r);
  await vi.advanceTimersByTimeAsync(2000);
  for (const r of short) expect(r.peek).not.toHaveBeenCalled();

  const next = [row(400), row(456), row(512)];
  for (const r of next) offerPeek(r);
  await vi.advanceTimersByTimeAsync(1100);
  expect(next[0].peek).toHaveBeenCalledOnce();
  expect(short[0].peek).not.toHaveBeenCalled();
});

it("holds off while a row is touched or the list is moving", async () => {
  const { notePeekTouch, offerPeek } = await load();
  const rows = [row(100), row(156), row(212)];
  for (const r of rows) offerPeek(r);
  notePeekTouch(true);
  await vi.advanceTimersByTimeAsync(1100);
  expect(rows[0].peek).not.toHaveBeenCalled();
  notePeekTouch(false);

  // Scrolling: the row isn't where it was a moment ago.
  const moving = setInterval(() => {
    if (rows[0].y !== null) rows[0].y -= 1;
  }, 50);
  await vi.advanceTimersByTimeAsync(1100);
  expect(rows[0].peek).not.toHaveBeenCalled();
  clearInterval(moving);

  await vi.advanceTimersByTimeAsync(1100);
  expect(rows[0].peek).toHaveBeenCalledOnce();
});

it("forgets rows that unmount", async () => {
  const { offerPeek } = await load();
  const rows = [row(100), row(156), row(212), row(268)];
  const withdraw = rows.map((r) => offerPeek(r));
  withdraw[0]();
  await vi.advanceTimersByTimeAsync(1100);
  expect(rows[0].peek).not.toHaveBeenCalled();
  expect(rows[1].peek).toHaveBeenCalledOnce();
});

it("doesn't spend the cue on a screen that blurs while it's checking", async () => {
  const { offerPeek } = await load();
  const rows = [row(100), row(156), row(212)];
  let withdraw = rows.map((r) => offerPeek(r));
  // The attempt has measured and is waiting to see the list hold still...
  await vi.advanceTimersByTimeAsync(950);
  // ...when an album page is pushed over it.
  for (const w of withdraw) w();
  await vi.advanceTimersByTimeAsync(2000);
  for (const r of rows) expect(r.peek).not.toHaveBeenCalled();
  expect(env.stored.has("swipe-actions.peek-shown.v1")).toBe(false);

  // Back on it, it gets the cue.
  withdraw = rows.map((r) => offerPeek(r));
  await vi.advanceTimersByTimeAsync(1100);
  expect(rows[0].peek).toHaveBeenCalledOnce();
  expect(env.stored.get("swipe-actions.peek-shown.v1")).toBe("1");
});
