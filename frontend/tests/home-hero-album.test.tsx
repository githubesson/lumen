import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Album } from "../src/api";
import Home from "../src/pages/Home";
import { clearResourceCache } from "../src/lib/resourceCache";

const mock = vi.hoisted(() => ({
  recent: vi.fn(), tracks: vi.fn(), getAlbum: vi.fn(),
}));
vi.mock("../../core/src/api", async (original) => ({
  ...await original<typeof import("../../core/src/api")>(),
  api: { listRecent: mock.recent, listTracks: mock.tracks, getAlbum: mock.getAlbum },
}));
vi.mock("../src/context/Auth", () => ({ useAuth: () => ({ me: { id: "user", username: "Listener" } }) }));
vi.mock("../src/context/Player", () => ({ usePlayerControls: () => ({ play: vi.fn() }) }));
vi.mock("../src/context/Favorites", () => ({
  useFavorites: () => ({ tracks: [], ids: new Set(), loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../src/context/Playlists", () => ({
  usePlaylists: () => ({ data: [], loading: false, error: null, reload: vi.fn() }),
}));
vi.mock("../src/lib/useTrackContextMenu", () => ({ useTrackContextMenu: () => ({ bind: vi.fn(), menu: null }) }));
vi.mock("../src/components/MediaCard", () => ({
  default: () => null,
  MediaCardPlaceholders: () => null,
}));

const album: Album = {
  id: "a1", title: "Library LP", is_compilation: false, track_count: 9, duration_ms: 1, has_cover: true,
  release_year: 2019,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearResourceCache();
  mock.tracks.mockResolvedValue([]);
  mock.getAlbum.mockResolvedValue(album);
});
afterEach(cleanup);

const openAlbum = () => screen.getByRole("link", { name: "Open album" }).getAttribute("href");

it("links a streamed TIDAL hero to its release and skips its hidden album", async () => {
  mock.recent.mockResolvedValue([{
    id: "tidal:1", title: "Streamed", album_title: "TIDAL LP", duration_ms: 1,
    source: "tidal", album_id: "hidden", source_album_id: "77",
  }]);
  render(<MemoryRouter><Home /></MemoryRouter>);
  await act(async () => {});
  expect(openAlbum()).toBe("/library?view=albums&tidalAlbum=77");
  expect(mock.getAlbum).not.toHaveBeenCalled();
});

it("describes and links a library hero's album", async () => {
  mock.recent.mockResolvedValue([{
    id: "t1", title: "Local", album_title: "Library LP", duration_ms: 1, source: "local", album_id: "a1",
  }]);
  render(<MemoryRouter><Home /></MemoryRouter>);
  await act(async () => {});
  expect(openAlbum()).toBe("/library?view=albums&album=a1");
  expect(mock.getAlbum).toHaveBeenCalledWith("a1", expect.anything());
  expect(screen.getByText("9 tracks")).toBeTruthy();
});

it("offers no album link for a TIDAL hero without a release id", async () => {
  mock.recent.mockResolvedValue([{
    id: "tidal:1", title: "Streamed", duration_ms: 1, source: "tidal", album_id: "hidden",
  }]);
  render(<MemoryRouter><Home /></MemoryRouter>);
  await act(async () => {});
  expect(screen.queryByRole("link", { name: "Open album" })).toBeNull();
});
