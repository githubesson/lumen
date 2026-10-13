import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaylistTrackEntry } from "../src/api";
import PlaylistDetail from "../src/pages/PlaylistDetail";
import { clearResourceCache } from "../src/lib/resourceCache";

const mock = vi.hoisted(() => ({
  getPlaylist: vi.fn(),
  listPlaylistTracksIfChanged: vi.fn(),
  listCollaborators: vi.fn(),
}));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: mock,
}));
const auth = vi.hoisted(() => ({ me: { id: "u1", role: "admin" } }));
vi.mock("../src/context/Auth", () => ({ useAuth: () => auth }));
const controls = vi.hoisted(() => ({ play: () => {}, shuffle: false }));
vi.mock("../src/context/Player", () => ({ usePlayer: () => controls, usePlayerControls: () => controls }));
const favorites = vi.hoisted(() => ({ isFavorite: () => false, toggle: () => Promise.resolve() }));
vi.mock("../src/context/Favorites", () => ({ useFavorites: () => favorites }));
const playlists = vi.hoisted(() => ({ data: null, reload: () => Promise.resolve(), update: () => {} }));
vi.mock("../src/context/Playlists", () => ({ usePlaylists: () => playlists }));
vi.mock("../src/lib/keybindings", async (original) => ({
  ...(await original<typeof import("../src/lib/keybindings")>()),
  useKey: () => {},
  useModalKeyScope: () => {},
}));
vi.mock("../src/pages/playlist/PlaylistTracksPanel", () => ({ default: () => null }));

const NOW = Date.parse("2026-10-02T12:00:00Z");
const tidalRows = ["A", "B"].map(
  (title, position) =>
    ({ position, track_id: `t-${title}`, title, duration_ms: 1000, source: "tidal" }) as PlaylistTrackEntry,
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mock.getPlaylist.mockResolvedValue({
    id: "p1",
    name: "Mix",
    visibility: "private",
    effective_role: "owner",
    owner_id: "u1",
    tidal_auto_download: true,
  });
  mock.listCollaborators.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  clearResourceCache();
});

async function renderPage() {
  render(
    <MemoryRouter initialEntries={["/playlists/p1"]}>
      <Routes><Route path="/playlists/:id" element={<PlaylistDetail />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
}

it("refetches every 20 s while the server has entries queued", async () => {
  mock.listPlaylistTracksIfChanged.mockResolvedValue({
    etag: "v1",
    data: { tracks: tidalRows, tidal_queued: 1 },
  });
  await renderPage();
  expect(screen.getByText("1 queued for download")).toBeTruthy();

  await act(async () => { vi.advanceTimersByTime(20_000); });
  expect(mock.listPlaylistTracksIfChanged).toHaveBeenCalledTimes(2);
  expect(mock.listPlaylistTracksIfChanged.mock.calls[1].slice(0, 2)).toEqual(["p1", "v1"]);
});

it("doesn't count failed downloads as queued, and looks again when their retry is due", async () => {
  mock.listPlaylistTracksIfChanged.mockResolvedValue({
    etag: "v1",
    data: { tracks: tidalRows, tidal_queued: 0, tidal_retry_at: new Date(NOW + 3_600_000).toISOString() },
  });
  await renderPage();
  expect(screen.queryByText(/queued for download/)).toBeNull();

  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(mock.listPlaylistTracksIfChanged).toHaveBeenCalledTimes(1);

  // Unchanged (304): the retry is due now, so it keeps looking every 20 s.
  mock.listPlaylistTracksIfChanged.mockResolvedValue({ etag: "v1", data: null });
  await act(async () => { vi.advanceTimersByTime(3_600_000 - 60_000); });
  expect(mock.listPlaylistTracksIfChanged).toHaveBeenCalledTimes(2);
  await act(async () => { vi.advanceTimersByTime(20_000); });
  expect(mock.listPlaylistTracksIfChanged).toHaveBeenCalledTimes(3);
});

it("stops refetching once nothing is queued or waiting", async () => {
  mock.listPlaylistTracksIfChanged.mockResolvedValue({
    etag: "v1",
    data: { tracks: tidalRows, tidal_queued: 0 },
  });
  await renderPage();
  await act(async () => { vi.advanceTimersByTime(120_000); });
  expect(mock.listPlaylistTracksIfChanged).toHaveBeenCalledTimes(1);
});

it("stops polling when the page goes away mid-read", async () => {
  mock.listPlaylistTracksIfChanged.mockResolvedValueOnce({
    etag: "v1",
    data: { tracks: tidalRows, tidal_queued: 1 },
  });
  // The next read is still out when the page unmounts; it settles on abort.
  mock.listPlaylistTracksIfChanged.mockImplementation(
    (_id: string, _etag: string, { signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
  );
  await renderPage();
  await act(async () => { vi.advanceTimersByTime(20_000); });
  expect(mock.listPlaylistTracksIfChanged).toHaveBeenCalledTimes(2);

  cleanup();
  // Let the aborted read settle before the clock moves on.
  await act(async () => {});
  for (let i = 0; i < 6; i++) await act(async () => { vi.advanceTimersByTime(20_000); });
  expect(mock.listPlaylistTracksIfChanged).toHaveBeenCalledTimes(2);
});
