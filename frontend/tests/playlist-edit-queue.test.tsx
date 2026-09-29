import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaylistTrackEntry } from "../src/api";
import PlaylistDetail from "../src/pages/PlaylistDetail";

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
afterEach(() => { cleanup(); vi.clearAllMocks(); });

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
