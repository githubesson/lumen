import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybackDevice, TrackListItem } from "@music-library/core";
import { QueueList, useQueuePosition } from "../src/components/QueuePopover";

const mock = vi.hoisted(() => ({
  player: {
    queue: [] as TrackListItem[],
    index: 0,
    current: null as TrackListItem | null,
  },
  jumpTo: vi.fn(),
  targetDevice: null as PlaybackDevice | null,
}));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => mock.player,
  usePlayerControls: () => ({ jumpTo: mock.jumpTo }),
  useRemotePlayback: () => ({ targetDevice: mock.targetDevice }),
}));
vi.mock("../src/components/CoverArt", () => ({ default: () => null }));

const tracks = Array.from({ length: 50 }, (_, i): TrackListItem => ({
  id: `t${i}`,
  title: `Track ${i}`,
  duration_ms: 1000,
}));
const desktop: PlaybackDevice = {
  deviceId: "desktop",
  deviceName: "Desktop",
  online: true,
  controlEnabled: true,
  capabilities: ["queue"],
  connectedAt: "",
  activity: null,
};

beforeEach(() => {
  mock.jumpTo.mockReset();
  mock.targetDevice = null;
  mock.player = { queue: tracks, index: 24, current: tracks[24] };
});
afterEach(cleanup);

it("counts a local queue from its own length", () => {
  const { result } = renderHook(() => useQueuePosition());
  expect(result.current).toBe("25 / 50");
  render(<QueueList />);
  expect(screen.getByText("Up next · 25")).toBeTruthy();
});

it("counts a remote device's window against its whole queue", () => {
  // Window of 50 starting at 100 of a 300-track queue.
  mock.targetDevice = {
    ...desktop,
    queue: {
      revision: "r1",
      tracks,
      index: 24,
      offset: 100,
      total: 300,
      shuffle: false,
      repeat: "off",
    },
  };
  const { result } = renderHook(() => useQueuePosition());
  expect(result.current).toBe("125 / 300");
  render(<QueueList />);
  expect(screen.getByText("Up next · 175")).toBeTruthy();
  // Rows still jump by their place in the window; routing adds the offset.
  fireEvent.click(screen.getByText("Track 25"));
  expect(mock.jumpTo).toHaveBeenCalledWith(25);
});

it("has no position with nothing playing", () => {
  mock.player = { queue: [], index: 0, current: null };
  const { result } = renderHook(() => useQueuePosition());
  expect(result.current).toBeNull();
});
