import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReplayData } from "../src/api";
import Replay from "../src/pages/Replay";
import { clearResourceCache, writeCache } from "../src/lib/resourceCache";

const mock = vi.hoisted(() => ({ replay: vi.fn() }));
vi.mock("../../core/src/api", async (original) => ({
  ...await original<typeof import("../../core/src/api")>(),
  api: { getReplay: mock.replay },
}));
vi.mock("../src/context/Player", () => ({ usePlayer: () => ({ play: vi.fn(), shuffle: false }) }));
vi.mock("../src/context/Playlists", () => ({ usePlaylists: () => ({ reload: vi.fn() }) }));

const empty: ReplayData = {
  summary: { total_plays: 0, total_ms: 0, unique_tracks: 0, unique_artists: 0 },
  top_tracks: [], top_artists: [], top_albums: [], top_genres: [], activity: [], bucket: "day", available_years: [],
};

function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}

async function renderAt(url: string) {
  render(<MemoryRouter initialEntries={[url]}><Replay /><Location /></MemoryRouter>);
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  clearResourceCache();
  mock.replay.mockResolvedValue(empty);
});
afterEach(cleanup);

const days = (range: { from?: string; to?: string }) =>
  (Date.parse(range.to!) - Date.parse(range.from!)) / 86_400_000;

it("opens on the period a link names", async () => {
  await renderAt("/replay?period=last-30");
  expect(screen.getByRole("tab", { name: "Last 30 days" }).getAttribute("aria-selected")).toBe("true");
  expect(days(mock.replay.mock.calls[0][0])).toBe(30);
});

it("opens on this year without one, and keeps the picked period in the URL", async () => {
  await renderAt("/replay");
  expect(screen.getByRole("tab", { name: "This year" }).getAttribute("aria-selected")).toBe("true");
  await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Last 30 days" })));
  expect(screen.getByTestId("location").textContent).toBe("?period=last-30");
  expect(days(mock.replay.mock.lastCall![0])).toBe(30);
  await act(async () => fireEvent.click(screen.getByRole("tab", { name: "This year" })));
  expect(screen.getByTestId("location").textContent).toBe("");
});

const thisYear = new Date().getFullYear();
const startsThisYear = (range: { from?: string }) => range.from!.startsWith(`${thisYear}-01-01`);

it("rewrites a value that isn't a period, or names this year, to the default", async () => {
  for (const value of ["bogus", "this-year", `year:${thisYear}`]) {
    mock.replay.mockClear();
    await renderAt(`/replay?period=${value}`);
    expect(screen.getByTestId("location").textContent, value).toBe("");
    expect(screen.getByRole("tab", { name: "This year" }).getAttribute("aria-selected")).toBe("true");
    expect(mock.replay.mock.calls.every(([range]) => startsThisYear(range)), value).toBe(true);
    cleanup();
  }
});

it("keeps a year with plays and selects its pill", async () => {
  writeCache("replay:years", [2025]);
  mock.replay.mockResolvedValue({ ...empty, available_years: [2025] });
  await renderAt("/replay?period=year:2025");
  expect(screen.getByTestId("location").textContent).toBe("?period=year:2025");
  expect(screen.getByRole("tab", { name: "2025" }).getAttribute("aria-selected")).toBe("true");
});

it("opens this year for a year without plays, without asking for it once the years are known", async () => {
  writeCache("replay:years", [2025]);
  await renderAt("/replay?period=year:1999");
  expect(screen.getByTestId("location").textContent).toBe("");
  expect(mock.replay.mock.calls.every(([range]) => startsThisYear(range))).toBe(true);
});

it("drops a year without plays when the first answer says which years exist", async () => {
  mock.replay.mockResolvedValue({ ...empty, available_years: [2025] });
  await renderAt("/replay?period=year:1999");
  await act(async () => {});
  expect(screen.getByTestId("location").textContent).toBe("");
  expect(screen.getByRole("tab", { name: "This year" }).getAttribute("aria-selected")).toBe("true");
  expect(startsThisYear(mock.replay.mock.lastCall![0])).toBe(true);
});
