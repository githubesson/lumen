import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ProgressBar from "../src/components/player/ProgressBar";

vi.mock("../src/context/Player", () => ({
  usePlayerTime: () => ({ currentTime: 0, duration: 0 }),
  usePlayerControls: () => ({ seek: vi.fn() }),
}));
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("advances a polled position between polls while it plays, and holds it when paused", () => {
  vi.useFakeTimers({ now: 100_000 });
  const override = { currentTime: 10, duration: 200, onSeek: vi.fn() };
  const { rerender } = render(<ProgressBar miniPlayerMode={false} override={{ ...override, sampledAt: 100_000 }} />);
  expect(screen.getByText("0:10")).toBeTruthy();
  act(() => { vi.advanceTimersByTime(2000); });
  expect(screen.getByText("0:12")).toBeTruthy();
  rerender(<ProgressBar miniPlayerMode={false} override={override} />);
  act(() => { vi.advanceTimersByTime(2000); });
  expect(screen.getByText("0:10")).toBeTruthy();
});
