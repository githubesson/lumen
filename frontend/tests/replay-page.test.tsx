import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReplayData } from "@music-library/core/api";
import { replayQueries } from "@music-library/core/replay/replay";
import { clearResourceCache, readCache, writeCache } from "../src/lib/resourceCache";
import Replay from "../src/pages/Replay";

const mock = vi.hoisted(() => ({ getReplay: vi.fn(), play: vi.fn() }));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: { getReplay: mock.getReplay },
}));
vi.mock("../src/context/Playlists", () => ({ usePlaylists: () => ({ reload: () => Promise.resolve() }) }));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => ({ current: null, isPlaying: false }),
  usePlayerControls: () => ({ play: mock.play }),
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

function renderPage(path = "/replay") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Replay />
    </MemoryRouter>,
  );
}

it("asks for plays by day and caches them under the daily key", async () => {
  const daily = answer("day", 10);
  mock.getReplay.mockResolvedValue(daily);
  renderPage();
  await screen.findByText("Also on repeat");

  const { range, daily: query } = replayQueries({ kind: "this-year" });
  expect(mock.getReplay).toHaveBeenCalledTimes(1);
  expect(mock.getReplay).toHaveBeenCalledWith(
    { from: range.from, to: range.to, bucket: "day" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(readCache(query.cacheKey)).toBe(daily);
  expect(screen.getByText("Days with plays")).toBeTruthy();
});

it("asks again by month when the daily series was cut short, and keeps that apart from the daily key", async () => {
  const { daily, monthly: query } = replayQueries({ kind: "this-year" });
  // An earlier daily answer, from before the history outgrew the cap.
  writeCache(daily.cacheKey, answer("day", 10));
  const monthly = answer("month", 10);
  mock.getReplay.mockResolvedValueOnce(answer("day", 4)).mockResolvedValueOnce(monthly);
  renderPage();
  await screen.findByText("Months with plays");

  expect(mock.getReplay).toHaveBeenCalledTimes(2);
  expect(mock.getReplay.mock.calls[1][0]).toMatchObject({ bucket: "month" });
  expect(screen.queryByText("Days with plays")).toBeNull();
  expect(screen.getByText(/a month on average$/)).toBeTruthy();
  // Never under the daily key, which Home reads as days; and the old daily
  // answer is gone, so it can't come back in front of this one.
  expect(readCache(query.cacheKey)).toBe(monthly);
  expect(readCache(daily.cacheKey)).toBeUndefined();
});

it("opens on the last 30 days Home already loaded, while it refreshes", async () => {
  const fromHome = answer("day", 10);
  writeCache(replayQueries({ kind: "last-30" }).daily.cacheKey, fromHome);
  mock.getReplay.mockReturnValue(new Promise(() => {}));
  renderPage("/replay?period=last-30");
  expect(screen.getByText("Also on repeat")).toBeTruthy();
  expect(mock.getReplay.mock.calls[0][0]).toMatchObject({ bucket: "day" });
});

it("opens a top artist's page when they have one, plays them when they don't, and links only artists with a page", async () => {
  const data = answer("day", 10);
  data.top_tracks = [
    {
      ...track("a", 6),
      artist: "Earth, Wind & Fire, Kestrel Bay",
      primary_artists: [
        { id: "ar-ewf", name: "Earth, Wind & Fire", has_page: false },
        { id: "ar-kestrel", name: "Kestrel Bay", has_page: true },
      ],
    },
    track("b", 4),
  ];
  data.top_artists = [
    { id: "ar-kestrel", name: "Kestrel Bay", plays: 10, has_page: true },
    { id: "ar-ewf", name: "Earth, Wind & Fire", plays: 6, has_page: false },
    { id: "ar-gone", name: "Gone", plays: 1, has_page: false },
  ];
  mock.getReplay.mockResolvedValue(data);
  renderPage();
  await screen.findByText("Also on repeat");

  const artists = within(screen.getByRole("region", { name: "Top artists" }));
  const open = artists.getByRole("link", { name: "Open Kestrel Bay" });
  expect(open.getAttribute("href")).toBe("/library?view=artists&artist=ar-kestrel");
  expect(open.closest(".card")!.querySelector('[data-action="open"]')).not.toBeNull();
  expect(artists.queryByRole("button", { name: "Play Kestrel Bay" })).toBeNull();

  const play = artists.getByRole("button", { name: "Play Earth, Wind & Fire" });
  expect(play.closest(".card")!.querySelector('[data-action="play"]')).not.toBeNull();
  await act(async () => fireEvent.click(play));
  expect(mock.play).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), [expect.objectContaining({ id: "a" })]);

  const gone = artists.getByText("Gone");
  expect(gone.closest("a, button")).toBeNull();
  expect(gone.closest(".card")!.querySelector("[data-action]")).toBeNull();

  // The most played track's artists: whole names, linked only with a page.
  const featured = within(screen.getByRole("article", { name: "Most played track" }));
  expect(featured.getByRole("link", { name: "Kestrel Bay" }).getAttribute("href")).toBe(
    "/library?view=artists&artist=ar-kestrel",
  );
  expect(featured.queryByRole("link", { name: /Earth/ })).toBeNull();
  expect(featured.getByText(/Earth, Wind & Fire/)).toBeTruthy();
});

it("leaves the most played track's artists unlinked when the server doesn't list them", async () => {
  const data = answer("day", 10);
  data.top_tracks = [{ ...track("a", 6), artist: "Earth, Wind & Fire" }];
  data.top_artists = [{ id: "ar-ewf", name: "Earth, Wind & Fire", plays: 6 }];
  mock.getReplay.mockResolvedValue(data);
  renderPage();
  await screen.findByText("Most played track");

  const featured = within(screen.getByRole("article", { name: "Most played track" }));
  expect(featured.queryByRole("link", { name: /Earth/ })).toBeNull();
  // Without has_page the tile plays, as it would on Home.
  expect(screen.getByRole("button", { name: "Play Earth, Wind & Fire" })).toBeTruthy();
});
