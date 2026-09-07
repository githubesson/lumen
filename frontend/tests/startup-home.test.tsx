import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import type { Playlist, TrackListItem } from "../src/api";
import { FavoritesProvider } from "../src/context/Favorites";
import { PlaylistsProvider, usePlaylists } from "../src/context/Playlists";
import Home from "../src/pages/Home";

const mock = vi.hoisted(() => ({
  recent: vi.fn(), tracks: vi.fn(), favorites: vi.fn(), playlists: vi.fn(),
  auth: { status: "authed", me: { id: "user", username: "Listener", must_reset_password: false } },
}));
vi.mock("../../core/src/auth/auth-core", () => ({ useAuth: () => mock.auth }));
vi.mock("../../core/src/api", async (original) => ({
  ...await original<typeof import("../../core/src/api")>(),
  api: { listRecent: mock.recent, listTracks: mock.tracks, listFavorites: mock.favorites, listPlaylists: mock.playlists },
}));
vi.mock("../src/context/Player", () => ({ usePlayer: () => ({ play: vi.fn() }) }));
vi.mock("../src/components/TrackContextMenu", () => ({ useTrackContextMenu: () => ({ bind: vi.fn(), menu: null }) }));
vi.mock("../src/components/MediaCard", () => ({ default: ({ title }: { title: string }) => <div>{title}</div> }));
vi.mock("../src/components/PlaylistCard", () => ({ default: ({ playlist }: { playlist: Playlist }) => <div>{playlist.name}</div> }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function Sidebar() {
  const { data } = usePlaylists();
  return <aside>{data?.map((playlist) => <span key={playlist.id}>{playlist.name}</span>)}</aside>;
}

function renderHome() {
  return render(
    <MemoryRouter>
      <FavoritesProvider>
        <PlaylistsProvider>
          <Sidebar />
          <Link to="/library">Away</Link><Link to="/">Home</Link>
          <Routes><Route path="/" element={<Home />} /><Route path="/library" element={<div>Library</div>} /></Routes>
        </PlaylistsProvider>
      </FavoritesProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [mock.recent, mock.tracks, mock.favorites, mock.playlists]) fn.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("shows recent music before slower lists finish and shares the startup requests", async () => {
  const recent = deferred<TrackListItem[]>();
  const favorites = deferred<TrackListItem[]>();
  const playlists = deferred<Playlist[]>();
  mock.recent.mockReturnValue(recent.promise);
  mock.favorites.mockReturnValue(favorites.promise);
  mock.playlists.mockReturnValue(playlists.promise);
  renderHome();
  expect(screen.queryByText("Nothing ingested yet")).toBeNull();
  await act(async () => { recent.resolve([{ id: "track", title: "Ready to play", duration_ms: 180000 }]); });
  expect(screen.getByRole("heading", { name: "Ready to play" })).toBeTruthy();
  expect(screen.getByText("Loading playlists…")).toBeTruthy();
  expect(mock.favorites).toHaveBeenCalledTimes(1);
  expect(mock.playlists).toHaveBeenCalledTimes(1);
  await act(async () => { favorites.resolve([]); playlists.resolve([]); });
});

it("offers a retry for a failed section without discarding successful music", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mock.recent.mockResolvedValue([{ id: "track", title: "Still playable" }]);
  mock.favorites.mockRejectedValueOnce(new Error("offline"));
  renderHome();
  await act(async () => {});
  expect(screen.getByRole("heading", { name: "Still playable" })).toBeTruthy();
  const retry = screen.getByRole("button", { name: "Retry your favorites" });
  mock.favorites.mockResolvedValue([{ id: "favorite", title: "Recovered favorite" }]);
  await act(async () => { fireEvent.click(retry); });
  expect(screen.getByText("Recovered favorite")).toBeTruthy();
  expect(mock.favorites).toHaveBeenCalledTimes(2);
  expect(mock.recent).toHaveBeenCalledTimes(1);
});

it("revalidates shared lists when returning home after navigation", async () => {
  renderHome();
  await act(async () => {});
  expect(mock.playlists).toHaveBeenCalledTimes(1);
  expect(mock.favorites).toHaveBeenCalledTimes(1);
  await act(async () => { fireEvent.click(screen.getByText("Away")); });
  await act(async () => { fireEvent.click(screen.getByText("Home", { selector: "a" })); });
  expect(mock.playlists).toHaveBeenCalledTimes(2);
  expect(mock.favorites).toHaveBeenCalledTimes(2);
});
