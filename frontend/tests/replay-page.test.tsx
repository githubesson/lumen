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

it("asks all time again by month when the daily series was cut short, and keeps that apart from the daily key", async () => {
  const { daily, monthly: query } = replayQueries({ kind: "all" });
  // An earlier daily answer, from before the history outgrew the cap.
  writeCache(daily.cacheKey, answer("day", 10));
  const monthly = answer("month", 10);
  mock.getReplay.mockResolvedValueOnce(answer("day", 4)).mockResolvedValueOnce(monthly);
  renderPage("/replay?period=all");
  await screen.findByText("Months with plays");

  expect(mock.getReplay).toHaveBeenCalledTimes(2);
  expect(mock.getReplay.mock.calls[0][0]).toEqual({ from: undefined, to: undefined, bucket: "day" });
  expect(mock.getReplay.mock.calls[1][0]).toEqual({ from: undefined, to: undefined, bucket: "month" });
  expect(screen.queryByText("Days with plays")).toBeNull();
  expect(screen.getByText(/a month on average$/)).toBeTruthy();
  // Never under the daily key, which Home reads as days; and the old daily
  // answer is gone, so it can't come back in front of this one.
  expect(readCache(query!.cacheKey)).toBe(monthly);
  expect(readCache(daily.cacheKey)).toBeUndefined();
});

it("asks all time by month straight away once it has come back by month", async () => {
  const { daily, monthly: query } = replayQueries({ kind: "all" });
  writeCache(query!.cacheKey, answer("month", 10));
  const fresh = answer("month", 10);
  mock.getReplay.mockResolvedValue(fresh);
  renderPage("/replay?period=all");
  await act(async () => {});

  // One request, by month: no thousands of days fetched only to be dropped.
  expect(mock.getReplay).toHaveBeenCalledTimes(1);
  expect(mock.getReplay.mock.calls[0][0]).toEqual({ from: undefined, to: undefined, bucket: "month" });
  expect(readCache(query!.cacheKey)).toBe(fresh);
  expect(readCache(daily.cacheKey)).toBeUndefined();
  expect(screen.getByText("Months with plays")).toBeTruthy();
});

it("never asks a bounded period by month, even when its days look cut short", async () => {
  const { range, daily, monthly } = replayQueries({ kind: "this-year" });
  expect(monthly).toBeNull();
  const short = answer("day", 4);
  mock.getReplay.mockResolvedValue(short);
  renderPage();
  await screen.findByText("Days with plays");

  expect(mock.getReplay).toHaveBeenCalledTimes(1);
  expect(mock.getReplay).toHaveBeenCalledWith(
    { from: range.from, to: range.to, bucket: "day" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  // Still under the key Home shares.
  expect(readCache(daily.cacheKey)).toBe(short);
});

it("names what the loading bento's days tile counts only when it's known", async () => {
  // All time: by day or by month, nothing says which until it answers.
  let answerDays!: (data: ReplayData) => void;
  mock.getReplay
    .mockReturnValueOnce(new Promise<ReplayData>((resolve) => (answerDays = resolve)))
    .mockResolvedValueOnce(answer("month", 10));
  renderPage("/replay?period=all");
  const loading = within(screen.getByLabelText("Loading Replay"));
  expect(loading.getByText("Plays")).toBeTruthy();
  expect(loading.queryByText(/with plays$/)).toBeNull();
  await act(async () => answerDays(answer("day", 4)));
  expect(screen.getByText("Months with plays")).toBeTruthy();
  cleanup();

  // A bounded period always counts days.
  mock.getReplay.mockReturnValue(new Promise(() => {}));
  renderPage("/replay?period=last-30");
  expect(within(screen.getByLabelText("Loading Replay")).getByText("Days with plays")).toBeTruthy();
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

  // The placeholder has the same headings, so wait for the loaded tile itself.
  const artists = within(await screen.findByRole("region", { name: "Top artists" }));
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
  const featured = within(await screen.findByRole("article", { name: "Most played track" }));
  expect(featured.queryByRole("link", { name: /Earth/ })).toBeNull();
  // Without has_page the tile plays, as it would on Home.
  expect(screen.getByRole("button", { name: "Play Earth, Wind & Fire" })).toBeTruthy();
});
