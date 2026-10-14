import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReplayData, TrackListItem } from "../src/api";
import Home from "../src/pages/Home";
import { ThemeProvider } from "../src/context/Theme";
import { clearResourceCache } from "../src/lib/resourceCache";
import { replayQueries } from "@music-library/core/replay/replay";

const mock = vi.hoisted(() => ({
  recent: vi.fn(), tracks: vi.fn(), replay: vi.fn(), getAlbum: vi.fn(), getTweaks: vi.fn(),
}));
vi.mock("../../core/src/api", async (original) => ({
  ...await original<typeof import("../../core/src/api")>(),
  api: { listRecent: mock.recent, listTracks: mock.tracks, getReplay: mock.replay, getAlbum: mock.getAlbum },
}));
// The desktop app, which reads the saved board from its config file.
vi.mock("../src/lib/platform", async (original) => ({
  ...await original<typeof import("../src/lib/platform")>(),
  isElectron: () => true,
  getTweaks: mock.getTweaks,
  saveTweaks: async () => {},
  setTitleBarTheme: async () => {},
}));
vi.mock("../src/context/Auth", () => ({ useAuth: () => ({ me: { id: "user", username: "Listener" } }) }));
vi.mock("../src/context/Player", () => ({ usePlayerControls: () => ({ play: vi.fn() }) }));
vi.mock("../src/context/Favorites", () => ({
  useFavorites: () => ({ tracks: [], ids: new Set(), loaded: true, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../src/context/Playlists", () => ({
  usePlaylists: () => ({ data: [], loading: false, error: null, reload: vi.fn() }),
}));
vi.mock("../src/lib/useTrackContextMenu", () => ({ useTrackContextMenu: () => ({ bind: vi.fn(), menu: null }) }));

const track = (id: string): TrackListItem => ({ id, title: `Track ${id}`, artist: "Kestrel Bay", duration_ms: 1, source: "local" });
const empty: ReplayData = {
  summary: { total_plays: 0, total_ms: 0, unique_tracks: 0, unique_artists: 0 },
  top_tracks: [], top_artists: [], top_albums: [], top_genres: [], activity: [], bucket: "day", available_years: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  clearResourceCache();
  localStorage.clear();
  mock.recent.mockResolvedValue([track("r1")]);
  mock.tracks.mockResolvedValue([]);
  mock.getAlbum.mockResolvedValue(null);
  mock.replay.mockResolvedValue(empty);
});
afterEach(cleanup);

it("asks for the periods of the board it read, not the default board's first", async () => {
  let read!: (value: unknown) => void;
  mock.getTweaks.mockReturnValue(new Promise((done) => { read = done; }));
  render(<MemoryRouter><ThemeProvider><Home /></ThemeProvider></MemoryRouter>);
  await act(async () => {});
  // The default board would show the last 30 days; nothing asks yet.
  expect(mock.replay).not.toHaveBeenCalled();

  await act(async () =>
    read({ tweaks: { homeBoard: { panels: [{ id: "stats", kind: "stats", w: 6, h: 1, period: "this-month" }] } } }),
  );
  expect(mock.replay).toHaveBeenCalledTimes(1);
  const from = mock.replay.mock.calls[0][0].from as string;
  expect(from.slice(0, 10)).toBe(replayQueries({ kind: "this-month" }).daily.params.from!.slice(0, 10));
});
