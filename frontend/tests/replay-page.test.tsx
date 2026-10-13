import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReplayData } from "@music-library/core/api";
import { replayRequest } from "@music-library/core/replay/replay";
import { clearResourceCache, readCache } from "../src/lib/resourceCache";
import Replay from "../src/pages/Replay";

const mock = vi.hoisted(() => ({ getReplay: vi.fn() }));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: mock,
}));
vi.mock("../src/context/Playlists", () => ({ usePlaylists: () => ({ reload: () => Promise.resolve() }) }));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => ({ current: null, isPlaying: false }),
  usePlayerControls: () => ({ play: () => {} }),
}));
vi.mock("../src/context/Favorites", () => ({
  useFavorites: () => ({ isFavorite: () => false, toggle: () => Promise.resolve() }),
}));

beforeEach(() => clearResourceCache());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const year = new Date().getFullYear();
const track = (id: string, plays: number) => ({
  id,
  title: `Track ${id}`,
  artist: "Kestrel Bay",
  duration_ms: 200_000,
  plays,
});

/** A "this year" answer whose buckets hold `counted` of its 10 plays. */
function answer(bucket: "day" | "month", counted: number): ReplayData {
  return {
    summary: { total_plays: 10, total_ms: 2_000_000, unique_tracks: 2, unique_artists: 1 },
    top_tracks: [track("a", 6), track("b", 4)],
    top_artists: [{ id: "ar-kestrel", name: "Kestrel Bay", plays: 10 }],
    top_albums: [],
    top_genres: [],
    activity: [{ bucket_start: new Date(Date.UTC(year, 0, bucket === "day" ? 5 : 1)).toISOString(), plays: counted }],
    bucket,
    available_years: [year],
  };
}

function renderPage() {
  render(
    <MemoryRouter>
      <Replay />
    </MemoryRouter>,
  );
}

it("asks for plays by day and caches them under the daily key", async () => {
  const daily = answer("day", 10);
  mock.getReplay.mockResolvedValue(daily);
  renderPage();
  await screen.findByText("Also on repeat");

  const { range, cacheKey } = replayRequest({ kind: "this-year" });
  expect(mock.getReplay).toHaveBeenCalledTimes(1);
  expect(mock.getReplay).toHaveBeenCalledWith(
    { from: range.from, to: range.to, bucket: "day" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  // A monthly answer cached under the old key ("replay:<period>") is never
  // read back as a daily one.
  expect(readCache(`replay:daily:${cacheKey}`)).toBe(daily);
  expect(screen.getByText("Days with plays")).toBeTruthy();
});

it("asks again by month when the daily series was cut short, and counts months", async () => {
  const monthly = answer("month", 10);
  mock.getReplay.mockResolvedValueOnce(answer("day", 4)).mockResolvedValueOnce(monthly);
  renderPage();
  await screen.findByText("Months with plays");

  expect(mock.getReplay).toHaveBeenCalledTimes(2);
  expect(mock.getReplay.mock.calls[1][0]).toMatchObject({ bucket: "month" });
  expect(screen.queryByText("Days with plays")).toBeNull();
  expect(screen.getByText(/a month on average$/)).toBeTruthy();
  expect(readCache(`replay:daily:${replayRequest({ kind: "this-year" }).cacheKey}`)).toBe(monthly);
});
