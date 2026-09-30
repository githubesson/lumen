import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LyricsSidebar from "../src/components/LyricsSidebar";
import { LyricsPanelProvider, useLyricsPanel } from "../src/context/LyricsPanel";

const mock = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  time: { currentTime: 0, duration: 180 },
  lyrics: vi.fn(),
  track: { id: "track", title: "Song", duration_ms: 180000 },
}));
vi.mock("../src/context/Player", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mock.listeners.add(listener);
    return () => { mock.listeners.delete(listener); };
  };
  return {
    usePlayer: () => ({ current: mock.track }),
    usePlayerTime: () => useSyncExternalStore(subscribe, () => mock.time),
  };
});
vi.mock("../src/lib/useTrackLyrics", () => ({
  useTrackLyrics: mock.lyrics,
  lyricsDurationSeconds: () => 180,
}));
vi.mock("../src/components/PlayerLyricsLine", () => ({
  default: ({ currentTime }: { currentTime: number }) => <p>Lyrics at {currentTime}</p>,
}));

function Toggle() {
  const { toggle } = useLyricsPanel();
  return <button onClick={toggle}>Toggle lyrics</button>;
}
function tick(currentTime: number) {
  act(() => {
    mock.time = { currentTime, duration: 180 };
    for (const listener of mock.listeners) listener();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mock.time = { currentTime: 0, duration: 180 };
  mock.lyrics.mockReset().mockReturnValue({ lyrics: null, loading: false, error: null });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("subscribes only while open or exiting and shows the latest clock when reopened", () => {
  render(<LyricsPanelProvider><Toggle /><LyricsSidebar /></LyricsPanelProvider>);
  expect(mock.listeners.size).toBe(0);
  expect(mock.lyrics).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("Toggle lyrics"));
  act(() => { vi.advanceTimersByTime(32); });
  tick(4);
  expect(screen.getByText("Lyrics at 4")).toBeTruthy();
  expect(mock.listeners.size).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Close lyrics panel" }));
  act(() => { vi.advanceTimersByTime(200); });
  expect(screen.getByText("Lyrics at 4")).toBeTruthy();
  act(() => { vi.advanceTimersByTime(80); });
  expect(mock.listeners.size).toBe(0);
  expect(screen.queryByText("Lyrics at 4")).toBeNull();
  mock.lyrics.mockClear();
  tick(10);
  expect(mock.lyrics).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("Toggle lyrics"));
  act(() => { vi.advanceTimersByTime(32); });
  expect(screen.getByText("Lyrics at 10")).toBeTruthy();
});
