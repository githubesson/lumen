import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaylistTrackEntry } from "../src/api";
import PlaylistDetail from "../src/pages/PlaylistDetail";
import { clearResourceCache, readCache, writeCache } from "../src/lib/resourceCache";

const mock = vi.hoisted(() => ({
  getPlaylist: vi.fn(),
  listPlaylistTracksIfChanged: vi.fn(),
  removePlaylistTrack: vi.fn(),
  listCollaborators: vi.fn(),
}));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: mock,
}));
const auth = vi.hoisted(() => ({ me: { id: "u1", role: "user" } }));
vi.mock("../src/context/Auth", () => ({ useAuth: () => auth }));
const controls = vi.hoisted(() => ({ play: () => {} }));
vi.mock("../src/context/Player", () => ({ usePlayerControls: () => controls }));
const favorites = vi.hoisted(() => ({ isFavorite: () => false, toggle: () => Promise.resolve() }));
vi.mock("../src/context/Favorites", () => ({ useFavorites: () => favorites }));
const playlists = vi.hoisted(() => ({ data: null, reload: () => Promise.resolve(), update: () => {} }));
vi.mock("../src/context/Playlists", () => ({ usePlaylists: () => playlists }));
vi.mock("../src/lib/keybindings", async (original) => ({
  ...(await original<typeof import("../src/lib/keybindings")>()),
  useKey: () => {},
  useModalKeyScope: () => {},
}));
vi.mock("../src/pages/playlist/PlaylistTracksPanel", () => ({
  default: ({ tracks, onRemove }: { tracks: PlaylistTrackEntry[]; onRemove: (position: number) => void }) => (
    <ul>
      {tracks.map((t) => (
        <li key={t.track_id}>
          <button type="button" onClick={() => onRemove(t.position)}>Remove {t.title}</button>
        </li>
      ))}
    </ul>
  ),
}));

const rows = (titles: string[]) =>
  titles.map((title, position) => ({ position, track_id: `t-${title}`, title, duration_ms: 1000, source: "local" }) as PlaylistTrackEntry);

beforeEach(() => {
  mock.getPlaylist.mockResolvedValue({ id: "p1", name: "Mix", visibility: "private", effective_role: "owner", owner_id: "u1" });
  mock.listPlaylistTracksIfChanged.mockResolvedValue({ etag: "v1", tracks: rows(["A", "B", "C"]) });
  mock.listCollaborators.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); clearResourceCache(); });

async function renderPage() {
  render(
    <MemoryRouter initialEntries={["/playlists/p1"]}>
      <Routes><Route path="/playlists/:id" element={<PlaylistDetail />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
}

it("queues a second remove behind one still in flight instead of dropping it", async () => {
  let finishFirst!: () => void;
  mock.removePlaylistTrack
    .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
    .mockResolvedValueOnce(undefined);
  await renderPage();

  fireEvent.click(screen.getByRole("button", { name: "Remove A" }));
  // Optimistic: B moved up to position 0, so its remove targets 0 after A's.
  fireEvent.click(screen.getByRole("button", { name: "Remove B" }));
  await act(async () => {});
  expect(mock.removePlaylistTrack).toHaveBeenCalledTimes(1);

  mock.listPlaylistTracksIfChanged.mockResolvedValue({ etag: "v3", tracks: rows(["C"]) });
  await act(async () => { finishFirst(); });
  expect(mock.removePlaylistTrack.mock.calls).toEqual([["p1", 0], ["p1", 0]]);
  expect(screen.queryByRole("button", { name: "Remove B" })).toBeNull();
  expect(screen.getByRole("button", { name: "Remove C" })).toBeTruthy();
});

it("addresses a queued remove by the position the server will have given the row", async () => {
  // Position 1 belongs to a row this viewer can't see (another user's
  // personal upload). Removing A shifts it and B up one on the server, so the
  // queued remove of B has to target 1, not B's index 0 (the hidden row).
  mock.listPlaylistTracksIfChanged.mockResolvedValue({
    etag: "v1",
    tracks: [
      { position: 0, track_id: "t-A", title: "A", duration_ms: 1000, source: "local" },
      { position: 2, track_id: "t-B", title: "B", duration_ms: 1000, source: "local" },
      { position: 3, track_id: "t-C", title: "C", duration_ms: 1000, source: "local" },
    ] as PlaylistTrackEntry[],
  });
  let finishFirst!: () => void;
  mock.removePlaylistTrack
    .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
    .mockResolvedValueOnce(undefined);
  await renderPage();

  fireEvent.click(screen.getByRole("button", { name: "Remove A" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove B" }));
  await act(async () => {});
  await act(async () => { finishFirst(); });
  expect(mock.removePlaylistTrack.mock.calls).toEqual([["p1", 0], ["p1", 1]]);
});

it("discards edits queued behind a failed one and reloads the server's rows", async () => {
  let failFirst!: (error: Error) => void;
  mock.removePlaylistTrack.mockImplementationOnce(
    () => new Promise<void>((_, reject) => { failFirst = reject; }),
  );
  await renderPage();

  fireEvent.click(screen.getByRole("button", { name: "Remove A" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove B" }));
  await act(async () => {});
  await act(async () => { failFirst(new Error("nope")); });

  expect(mock.removePlaylistTrack).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Remove A" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove B" })).toBeTruthy();
  expect(await screen.findByText("Failed to remove track.")).toBeTruthy();
});

it("drops the cached rows when an edit fails after leaving the page", async () => {
  let failRemove!: (error: Error) => void;
  mock.removePlaylistTrack.mockImplementationOnce(() => new Promise<void>((_, reject) => { failRemove = reject; }));
  const { unmount } = render(
    <MemoryRouter initialEntries={["/playlists/p1"]}>
      <Routes><Route path="/playlists/:id" element={<PlaylistDetail />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Remove A" }));
  await act(async () => {});
  expect(readCache<{ tracks: unknown[] }>("playlist:p1")?.tracks).toHaveLength(2);
  unmount();
  await act(async () => { failRemove(new Error("nope")); });
  expect(readCache("playlist:p1")).toBeUndefined();
});

it("reloads details and collaborators when an edit supersedes the mount load", async () => {
  writeCache("playlist:p1", {
    playlist: { id: "p1", name: "Mix", visibility: "private", effective_role: "owner", owner_id: "u1" },
    tracks: rows(["A", "B", "C"]),
    collabs: [],
  });
  let finishMountLoad!: () => void;
  mock.getPlaylist.mockImplementationOnce(() => new Promise((resolve) => {
    finishMountLoad = () => resolve({ id: "p1", name: "Old name", visibility: "private", effective_role: "owner", owner_id: "u1" });
  }));
  mock.getPlaylist.mockResolvedValue({ id: "p1", name: "Renamed elsewhere", visibility: "private", effective_role: "owner", owner_id: "u1" });
  mock.removePlaylistTrack.mockResolvedValue(undefined);
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Remove A" }));
  await act(async () => {});
  await act(async () => { finishMountLoad(); });
  expect(mock.getPlaylist).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText("Renamed elsewhere").length).toBeGreaterThan(0);
});
