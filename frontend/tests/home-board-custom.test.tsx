import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Playlist, ReplayData, TrackListItem } from "../src/api";
import type { HomeBoardTweak } from "../src/contracts/desktop";
import Home from "../src/pages/Home";
import { ThemeProvider } from "../src/context/Theme";
import { clearResourceCache } from "../src/lib/resourceCache";
import { replayQueries } from "@music-library/core/replay/replay";

const mock = vi.hoisted(() => ({
  recent: vi.fn(), tracks: vi.fn(), replay: vi.fn(), getAlbum: vi.fn(), albumTracks: vi.fn(),
  playlistTracks: vi.fn(), play: vi.fn(), bind: vi.fn(), playlists: [] as Playlist[] | null, playlistsFailed: false,
}));
vi.mock("../../core/src/api", async (original) => ({
  ...await original<typeof import("../../core/src/api")>(),
  api: {
    listRecent: mock.recent, listTracks: mock.tracks, getReplay: mock.replay, getAlbum: mock.getAlbum,
    listAlbumTracks: mock.albumTracks, listPlaylistTracks: mock.playlistTracks,
  },
}));
vi.mock("../src/context/Auth", () => ({ useAuth: () => ({ me: { id: "user", username: "Listener" } }) }));
vi.mock("../src/context/Player", () => ({ usePlayerControls: () => ({ play: mock.play }) }));
vi.mock("../src/context/Favorites", () => ({
  useFavorites: () => ({ tracks: [], ids: new Set(), loaded: true, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../src/context/Playlists", () => ({
  // Null while the shell is still loading them, or when that failed.
  usePlaylists: () => ({
    data: mock.playlists,
    loading: mock.playlists === null && !mock.playlistsFailed,
    error: mock.playlistsFailed ? "Could not load playlists." : null,
    reload: vi.fn(),
  }),
}));
vi.mock("../src/lib/useTrackContextMenu", () => ({ useTrackContextMenu: () => ({ bind: mock.bind, menu: null }) }));

const track = (id: string, artist: string, extra: Partial<TrackListItem> = {}): TrackListItem => ({
  id, title: `Track ${id}`, artist, duration_ms: 180_000, source: "local", ...extra,
});

const playlist = (id: string, name: string): Playlist =>
  ({ id, name, track_count: 2, owner_id: "user", visibility: "private" }) as unknown as Playlist;

/** A period's numbers: the tracks and their plays, and whatever else a test needs. */
function replay(top: { id: string; plays: number }[], extra: Partial<ReplayData> = {}): ReplayData {
  return {
    summary: {
      total_plays: top.reduce((sum, t) => sum + t.plays, 0),
      total_ms: 5_400_000,
      unique_tracks: top.length,
      unique_artists: 2,
      headline_artist: { id: "ar-k", name: "Kestrel Bay", plays: 9 },
    },
    top_tracks: top.map((t) => ({ ...track(t.id, "Kestrel Bay"), plays: t.plays })),
    top_artists: [], top_albums: [], top_genres: [], activity: [], bucket: "day", available_years: [2024],
    ...extra,
  };
}

/** The period a Replay request asked for, by its range's first day. */
const askedFor = () =>
  mock.replay.mock.calls.map(([params]: { from?: string }[]) => {
    for (const kind of ["last-30", "this-month", "this-year", "all"] as const) {
      const from = replayQueries({ kind }).daily.params.from;
      if (from?.slice(0, 10) === params.from?.slice(0, 10)) return kind;
    }
    return params.from ? params.from.slice(0, 10) : "all";
  });

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom doesn't lay out, and the dropdowns scroll their pick into view.
  Element.prototype.scrollIntoView = vi.fn();
  clearResourceCache();
  localStorage.clear();
  mock.playlists = [];
  mock.playlistsFailed = false;
  mock.recent.mockResolvedValue([track("r1", "Halden Marsh")]);
  mock.tracks.mockResolvedValue([track("n1", "Hana Okoro"), track("n2", "Halden Marsh")]);
  mock.getAlbum.mockResolvedValue(null);
  mock.replay.mockResolvedValue(replay([{ id: "a", plays: 9 }, { id: "b", plays: 5 }]));
});
afterEach(cleanup);

const arrange = (homeBoard: HomeBoardTweak) => localStorage.setItem("lumen.tweaks", JSON.stringify({ homeBoard }));
const savedBoard = (): HomeBoardTweak | undefined => JSON.parse(localStorage.getItem("lumen.tweaks") ?? "{}").homeBoard;
const panel = (id: string) => document.querySelector<HTMLElement>(`[data-panel="${id}"]`);
const order = () => [...document.querySelectorAll<HTMLElement>(".board-slot")].map((el) => el.dataset.panel);
const shapeOf = (id: string) => {
  const style = panel(id)!.style;
  return `${style.getPropertyValue("--board-span")}x${style.getPropertyValue("--board-rows")}`;
};
const tile = (name: string) => within(screen.getByRole("group", { name }));

async function renderHome(url = "/") {
  const view = render(<MemoryRouter initialEntries={[url]}><ThemeProvider><Home /></ThemeProvider></MemoryRouter>);
  await act(async () => {});
  return view;
}

/** Picks `option` from the dropdown named `name`. */
async function pick(scope: ReturnType<typeof within>, name: string, option: string) {
  fireEvent.click(scope.getByRole("combobox", { name }));
  const choice = await scope.findByRole("option", { name: option });
  await act(async () => fireEvent.click(choice));
  // Gone, as it would be by the next click.
  await waitFor(() => expect(scope.queryByRole("listbox")).toBeNull());
}

it("shows the new kinds of panel, each from the period it was given", async () => {
  mock.playlists = [playlist("pl-1", "Late drives")];
  const entry = (id: string, artist: string, position: number) => ({ ...track(id, artist), track_id: id, position });
  mock.playlistTracks.mockResolvedValue({ tracks: [entry("p1", "Kestrel Bay", 0), entry("p2", "Hana Okoro", 1)] });
  mock.replay.mockResolvedValue(
    replay([{ id: "a", plays: 9 }, { id: "b", plays: 5 }], {
      top_albums: [{ id: "al-1", title: "Weather", artist: "Kestrel Bay", plays: 7 }],
      top_genres: [{ genre: "Ambient", plays: 3 }, { genre: "Jazz", plays: 1 }],
      activity: [{ bucket_start: new Date().toISOString().slice(0, 10) + "T00:00:00Z", plays: 4 }],
    }),
  );
  arrange({
    panels: [
      { id: "stats", kind: "stats", w: 2, h: 1, period: "this-year" },
      { id: "genres", kind: "genres", w: 2, h: 1, period: "this-year" },
      { id: "top-albums", kind: "top-albums", w: 2, h: 1, period: "this-year", title: "Most played albums" },
      { id: "activity", kind: "activity", w: 6, h: 1, period: "this-year" },
      { id: "added", kind: "added", w: 3, h: 1 },
      { id: "playlist", kind: "playlist", w: 3, h: 1, playlist: "pl-1" },
    ],
  });
  await renderHome();

  // Four panels on one period make one request for it.
  expect(askedFor()).toEqual(["this-year"]);
  const stats = within(panel("stats")!);
  expect(stats.getByText("This year")).toBeTruthy();
  expect(stats.getByText("Your listening")).toBeTruthy();
  expect([...panel("stats")!.querySelectorAll(".board-stat")].map((el) => el.textContent)).toEqual([
    "Plays14", "Listening time1h 30m", "Tracks2", "Artists2",
  ]);
  expect(stats.getByText("Kestrel Bay")).toBeTruthy();
  expect([...panel("genres")!.querySelectorAll(".board-genre-name")].map((el) => el.textContent)).toEqual(["Ambient", "Jazz"]);
  expect(within(panel("genres")!).getByText("75%")).toBeTruthy();
  // Renamed, and its covers open and play the album.
  const albums = within(panel("top-albums")!);
  expect(albums.getByText("Most played albums")).toBeTruthy();
  expect(albums.getByRole("link", { name: /Weather/ }).getAttribute("href")).toBe("/library?view=albums&album=al-1");
  expect(albums.getByRole("link", { name: "view all →" }).getAttribute("href")).toBe("/replay?period=this-year");
  expect(panel("activity")!.querySelector(".activity-chart")).toBeTruthy();
  // The newest tracks, from the request Albums and the hero share.
  expect(within(panel("added")!).getAllByRole("listitem").map((row) => row.querySelector(".card-title")!.textContent)).toEqual([
    "Play Track n1", "Play Track n2",
  ]);
  // A playlist's tracks, under its name; each plays the playlist from there.
  const pinned = within(panel("playlist")!);
  expect(pinned.getByText("Late drives")).toBeTruthy();
  expect(mock.playlistTracks).toHaveBeenCalledWith("pl-1", expect.anything());
  fireEvent.click(pinned.getByRole("button", { name: "Play Track p2" }));
  expect(mock.play).toHaveBeenLastCalledWith(expect.objectContaining({ id: "p2" }), [
    expect.objectContaining({ id: "p1" }), expect.objectContaining({ id: "p2" }),
  ]);
  fireEvent.click(pinned.getByRole("button", { name: "Play all 2" }));
  expect(mock.play).toHaveBeenLastCalledWith(expect.objectContaining({ id: "p1" }), expect.any(Array));
});

it("asks for nothing from Replay when no panel shows a period", async () => {
  arrange({ panels: [{ id: "resume", kind: "resume", w: 6, h: 1 }, { id: "recent", kind: "recent", w: 6, h: 1 }] });
  await renderHome();
  expect(panel("recent")).toBeTruthy();
  expect(mock.replay).not.toHaveBeenCalled();
});

it("leaves off a playlist panel whose playlist is gone, without asking for it", async () => {
  mock.playlists = [playlist("pl-1", "Late drives")];
  arrange({
    panels: [
      { id: "recent", kind: "recent", w: 2, h: 1 },
      { id: "playlist", kind: "playlist", w: 2, h: 1, playlist: "pl-gone" },
    ],
  });
  await renderHome();
  expect(order()).toEqual(["recent"]);
  expect(mock.playlistTracks).not.toHaveBeenCalled();
  // The packed board widens what's left to close the gap.
  expect(shapeOf("recent")).toBe("6x1");
});

it("adds a panel for a period picked in Add a panel, at the end of the board", async () => {
  await renderHome("/?customize");
  const bar = within(screen.getByRole("region", { name: "Customize Home" }));
  await act(async () => fireEvent.click(bar.getByRole("button", { name: "Add panel" })));
  const dialog = within(await screen.findByRole("dialog", { name: "Add a panel" }));
  // A kind that can only be there once says it's on Home already.
  const recentRow = within(dialog.getByText("Recently played").closest("li")!);
  expect(recentRow.getByText("On Home")).toBeTruthy();

  const repeatRow = within(dialog.getByText("On repeat").closest("li")!);
  await pick(repeatRow, "Period for On repeat", "This year");
  await act(async () => fireEvent.click(repeatRow.getByRole("button", { name: "Add On repeat" })));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a panel" })).toBeNull());

  expect(order().at(-1)).toBe("repeat-2");
  // Its tile and its panel say which period it shows.
  expect(panel("repeat-2")!.querySelector(".board-slot-note")!.textContent).toBe("This year");
  expect(panel("repeat-2")!.querySelector(".section-sub")!.textContent).toBe("This year");
  expect(askedFor()).toEqual(["last-30", "this-year"]);
  expect(savedBoard()!.panels!.at(-1)).toEqual({ id: "repeat-2", kind: "repeat", w: 2, h: 2, period: "this-year" });
  // Named with its period, as is its tile, beside the other On repeat.
  expect(bar.getByRole("status").textContent).toBe("On repeat (This year) added.");
  expect(tile("On repeat (This year)")).toBeTruthy();
  expect(tile("On repeat (Last 30 days)")).toBeTruthy();
  // Focus goes to the new panel, ready to move it.
  expect(document.activeElement).toBe(within(panel("repeat-2")!).getByRole("button", { name: /^Move/ }));
});

it("shows a hidden panel from Add a panel rather than adding a second one", async () => {
  arrange({ panels: [{ id: "recent", kind: "recent", w: 2, h: 1, hidden: true }, { id: "albums", kind: "albums", w: 4, h: 1 }] });
  await renderHome("/?customize");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add panel" })));
  const row = within(within(await screen.findByRole("dialog", { name: "Add a panel" })).getByText("Recently played").closest("li")!);
  await act(async () => fireEvent.click(row.getByRole("button", { name: "Show Recently played" })));
  expect(order()).toEqual(["recent", "albums"]);
  expect(savedBoard()!.panels!.map((p) => p.id)).toEqual(["recent", "albums"]);
});

it("changes a panel's period, name and size from its settings", async () => {
  await renderHome("/?customize");
  await act(async () =>
    fireEvent.click(tile("On repeat (Last 30 days)").getByRole("button", { name: /^Edit\s*On repeat \(Last 30 days\)$/ })),
  );
  const dialog = within(await screen.findByRole("dialog", { name: "Edit On repeat" }));

  await pick(dialog, "Shows", "All time");
  expect(panel("repeat")!.querySelector(".section-sub")!.textContent).toBe("All time");
  expect(askedFor()).toContain("all");
  await pick(dialog, "Width", "Full");
  await pick(dialog, "Height", "Regular");
  expect(shapeOf("repeat")).toBe("6x1");

  // The name is saved when the dialog closes, not on every key.
  fireEvent.change(dialog.getByRole("textbox", { name: "Name" }), { target: { value: "Heavy rotation" } });
  expect(savedBoard()!.panels![1].title).toBeUndefined();
  await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Done" })));
  expect(savedBoard()!.panels![1]).toEqual({ id: "repeat", kind: "repeat", w: 6, h: 1, title: "Heavy rotation", period: "all" });
  expect(tile("Heavy rotation (All time)")).toBeTruthy();
  expect(panel("repeat")!.querySelector(".section-title")!.textContent).toBe("Heavy rotation");
});

it("removes a panel from its settings, and asks before Reset drops added ones", async () => {
  arrange({
    panels: [
      { id: "recent", kind: "recent", w: 2, h: 1 },
      { id: "stats", kind: "stats", w: 2, h: 1 },
      { id: "genres", kind: "genres", w: 2, h: 1 },
    ],
  });
  await renderHome("/?customize");
  await act(async () => fireEvent.click(tile("Your listening (Last 30 days)").getByRole("button", { name: /^Edit/ })));
  const settings = within(await screen.findByRole("dialog", { name: "Edit Your listening" }));
  await act(async () => fireEvent.click(settings.getByRole("button", { name: "Remove panel" })));
  expect(order()).toEqual(["recent", "genres"]);
  expect(savedBoard()!.panels!.map((p) => p.id)).toEqual(["recent", "genres"]);
  // Focus goes to the panel after it.
  expect(document.activeElement).toBe(within(panel("genres")!).getByRole("button", { name: /^Move/ }));

  const bar = within(screen.getByRole("region", { name: "Customize Home" }));
  await act(async () => fireEvent.click(bar.getByRole("button", { name: "Reset" })));
  const confirm = within(await screen.findByRole("dialog", { name: "Reset Home?" }));
  expect(confirm.getByText(/the 1 panel you added \(\s*Top genres \(Last 30 days\)\) is removed/)).toBeTruthy();
  await act(async () => fireEvent.click(confirm.getByRole("button", { name: "Cancel" })));
  expect(savedBoard()!.panels!.map((p) => p.id)).toEqual(["recent", "genres"]);

  await act(async () => fireEvent.click(bar.getByRole("button", { name: "Reset" })));
  const again = within(await screen.findByRole("dialog", { name: "Reset Home?" }));
  await act(async () => fireEvent.click(again.getByRole("button", { name: "Reset Home" })));
  expect(savedBoard()).toBeUndefined();
  expect(order()).toEqual(["resume", "repeat", "recent", "favorites", "albums", "playlists", "artists"]);
});

it("offers a way back when every panel was removed", async () => {
  arrange({ panels: [] });
  await renderHome();
  expect(screen.getByText("There are no panels on Home.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Customize Home" }));
  expect(screen.getByRole("button", { name: "Add panel" })).toBeTruthy();
});

it("sizes one request for the newest tracks for Albums and Recently added together", async () => {
  mock.tracks.mockResolvedValue([track("n1", "Hana Okoro", { album_id: "al-1", album_title: "Weather" })]);
  arrange({ panels: [{ id: "albums", kind: "albums", w: 3, h: 1 }, { id: "added", kind: "added", w: 3, h: 1 }] });
  await renderHome();
  expect(order()).toEqual(["albums", "added"]);
  expect(mock.tracks).toHaveBeenCalledTimes(1);
  expect(mock.tracks).toHaveBeenCalledWith(expect.objectContaining({ limit: 80 }));
});

it("shows a period's error once, in the first panel drawing on it", async () => {
  mock.replay.mockRejectedValue(new Error("offline"));
  arrange({
    panels: [
      { id: "stats", kind: "stats", w: 2, h: 1, period: "this-month" },
      { id: "genres", kind: "genres", w: 2, h: 1, period: "this-month" },
      { id: "recent", kind: "recent", w: 2, h: 1 },
    ],
  });
  await renderHome();
  expect(order()).toEqual(["stats", "recent"]);
  expect(within(panel("stats")!).getByText("Could not load what you've played this month.")).toBeTruthy();
  expect(within(panel("stats")!).getByRole("button", { name: "Retry your listening" })).toBeTruthy();
});

it("shows a period's error in the first panel that has something, not an empty one before it", async () => {
  mock.replay.mockResolvedValue(replay([{ id: "a", plays: 9 }]));
  arrange({
    panels: [
      { id: "genres", kind: "genres", w: 2, h: 1 },
      { id: "repeat", kind: "repeat", w: 2, h: 1 },
    ],
  });
  await renderHome();
  // No genre tags: Top genres is empty and off the board.
  expect(order()).toEqual(["repeat"]);

  // A revisit whose refresh fails: On repeat still has the last answer, and
  // carries the error; the empty Top genres doesn't come back to show it.
  cleanup();
  mock.replay.mockRejectedValue(new Error("offline"));
  await renderHome();
  expect(order()).toEqual(["repeat"]);
  expect(within(panel("repeat")!).getByRole("button", { name: "Retry on repeat" })).toBeTruthy();
});

it("puts Jump back in's own name over the hero", async () => {
  arrange({ panels: [{ id: "resume", kind: "resume", w: 6, h: 1, title: "Where I left off" }] });
  await renderHome();
  expect(panel("resume")!.querySelector(".hero-eyebrow")!.textContent).toBe("Where I left off");
});

it("saves a typed name when the field loses focus, or when Escape closes the dialog", async () => {
  await renderHome("/?customize");
  await act(async () => fireEvent.click(tile("Recently played").getByRole("button", { name: /^Edit/ })));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit Recently played" }));
  const name = dialog.getByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "Lately" } });
  await act(async () => fireEvent.blur(name));
  expect(savedBoard()!.panels!.find((p) => p.id === "recent")!.title).toBe("Lately");

  fireEvent.change(name, { target: { value: "Just now" } });
  await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(savedBoard()!.panels!.find((p) => p.id === "recent")!.title).toBe("Just now");
});

it("shows a deleted playlist's panel as empty while customizing, and says why", async () => {
  mock.playlists = [playlist("pl-1", "Late drives")];
  arrange({ panels: [{ id: "playlist", kind: "playlist", w: 6, h: 1, playlist: "pl-gone" }] });
  await renderHome("/?customize");
  const gonePanel = panel("playlist")!;
  expect(gonePanel.querySelectorAll(".board-placeholder")).toHaveLength(0);
  expect(gonePanel.querySelector('[aria-busy="true"]')).toBeNull();
  expect(tile("Playlist").getByText("Its playlist was deleted. Pick another in Edit.")).toBeTruthy();
  expect(mock.playlistTracks).not.toHaveBeenCalled();
});

it("says so when no panel has anything to show yet, rather than that they're hidden", async () => {
  mock.recent.mockResolvedValue([]);
  arrange({ panels: [{ id: "recent", kind: "recent", w: 3, h: 1 }, { id: "favorites", kind: "favorites", w: 3, h: 1 }] });
  await renderHome();
  expect(order()).toEqual([]);
  expect(screen.getByText("None of Home's panels has anything to show yet.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Customize Home" })).toBeTruthy();
});

it("waits for the user's playlists before asking for a pinned one's tracks", async () => {
  mock.playlists = null;
  mock.playlistTracks.mockResolvedValue({ tracks: [{ ...track("p1", "Kestrel Bay"), track_id: "p1", position: 0 }] });
  arrange({
    panels: [
      { id: "playlist", kind: "playlist", w: 3, h: 1, playlist: "pl-1" },
      { id: "playlist-2", kind: "playlist", w: 3, h: 1, playlist: "pl-gone" },
    ],
  });
  const view = await renderHome();
  // Placeholders meanwhile, not an error.
  expect(mock.playlistTracks).not.toHaveBeenCalled();
  expect(panel("playlist")!.querySelectorAll(".board-placeholder").length).toBeGreaterThan(0);
  expect(screen.queryByText("Could not load the playlist.")).toBeNull();

  // The list lands without the deleted one: only the other is asked for.
  mock.playlists = [playlist("pl-1", "Late drives")];
  view.rerender(<MemoryRouter><ThemeProvider><Home /></ThemeProvider></MemoryRouter>);
  await act(async () => {});
  expect(mock.playlistTracks.mock.calls.map(([id]) => id)).toEqual(["pl-1"]);
  expect(order()).toEqual(["playlist"]);
});

it("says there's nothing to pick for a deleted playlist's panel when no playlists are left", async () => {
  arrange({ panels: [{ id: "playlist", kind: "playlist", w: 6, h: 1, playlist: "pl-gone" }] });
  await renderHome("/?customize");
  expect(tile("Playlist").getByText("Its playlist was deleted, and there's no other to pick.")).toBeTruthy();
  await act(async () => fireEvent.click(tile("Playlist").getByRole("button", { name: /^Edit/ })));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit Playlist" }));
  expect(dialog.getByText("There are no playlists to show. Make one, or remove this panel.")).toBeTruthy();
  expect(dialog.queryByRole("combobox", { name: "Playlist" })).toBeNull();
});

it("asks for a pinned playlist anyway when the playlists list can't be had", async () => {
  mock.playlists = null;
  mock.playlistsFailed = true;
  mock.playlistTracks.mockResolvedValue({ tracks: [{ ...track("p1", "Kestrel Bay"), track_id: "p1", position: 0 }] });
  arrange({ panels: [{ id: "playlist", kind: "playlist", w: 6, h: 1, playlist: "pl-1" }] });
  const view = await renderHome();
  expect(mock.playlistTracks).toHaveBeenCalledWith("pl-1", expect.anything());
  expect(within(panel("playlist")!).getByRole("button", { name: "Play Track p1" })).toBeTruthy();

  // Retrying the list doesn't empty the panel or ask for its tracks again.
  mock.playlistsFailed = false;
  view.rerender(<MemoryRouter><ThemeProvider><Home /></ThemeProvider></MemoryRouter>);
  await act(async () => {});
  expect(within(panel("playlist")!).getByRole("button", { name: "Play Track p1" })).toBeTruthy();
  expect(mock.playlistTracks).toHaveBeenCalledTimes(1);
});

it("says another playlist can't be picked while the list is unavailable, not that there are none", async () => {
  mock.playlists = null;
  mock.playlistsFailed = true;
  mock.playlistTracks.mockResolvedValue({ tracks: [] });
  arrange({ panels: [{ id: "playlist", kind: "playlist", w: 6, h: 1, playlist: "pl-1" }] });
  await renderHome("/?customize");
  await act(async () => fireEvent.click(tile("Playlist").getByRole("button", { name: /^Edit/ })));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit Playlist" }));
  expect(dialog.getByText("Your playlists aren't available right now, so another can't be picked.")).toBeTruthy();
});

it("picks a playlist for a new Playlist panel once the list comes, even after Add panel opened", async () => {
  mock.playlists = null;
  const view = await renderHome("/?customize");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add panel" })));
  const dialog = await screen.findByRole("dialog", { name: "Add a panel" });
  const row = () => within(within(dialog).getByText("Playlist").closest("li")!);
  expect(row().getByText("Playlists aren't available right now")).toBeTruthy();

  mock.playlists = [playlist("pl-1", "Late drives"), playlist("pl-2", "Morning")];
  view.rerender(<MemoryRouter initialEntries={["/?customize"]}><ThemeProvider><Home /></ThemeProvider></MemoryRouter>);
  await act(async () => {});
  expect(row().getByRole("combobox", { name: "Playlist for the new Playlist panel" }).textContent).toContain("Late drives");
  await act(async () => fireEvent.click(row().getByRole("button", { name: "Add Playlist" })));
  expect(savedBoard()!.panels!.at(-1)).toMatchObject({ kind: "playlist", playlist: "pl-1" });
});

it("adds the playlist the user picks over the one it would start on", async () => {
  mock.playlists = [playlist("pl-1", "Late drives"), playlist("pl-2", "Morning")];
  await renderHome("/?customize");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add panel" })));
  const dialog = await screen.findByRole("dialog", { name: "Add a panel" });
  const row = within(within(dialog).getByText("Playlist").closest("li")!);
  await pick(row, "Playlist for the new Playlist panel", "Morning");
  await act(async () => fireEvent.click(row.getByRole("button", { name: "Add Playlist" })));
  expect(savedBoard()!.panels!.at(-1)).toMatchObject({ kind: "playlist", playlist: "pl-2" });
});

it("changes which playlist a Playlist panel shows from its settings", async () => {
  mock.playlists = [playlist("pl-1", "Late drives"), playlist("pl-2", "Morning")];
  mock.playlistTracks.mockResolvedValue({ tracks: [] });
  arrange({ panels: [{ id: "playlist", kind: "playlist", w: 6, h: 1, playlist: "pl-1" }] });
  await renderHome("/?customize");
  await act(async () => fireEvent.click(tile("Late drives").getByRole("button", { name: /^Edit/ })));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit Late drives" }));
  await pick(dialog, "Playlist", "Morning");
  expect(savedBoard()!.panels![0]).toMatchObject({ playlist: "pl-2" });
  expect(panel("playlist")!.querySelector(".section-title")!.textContent).toBe("Morning");
  expect(mock.playlistTracks.mock.calls.map(([id]) => id)).toEqual(["pl-1", "pl-2"]);
});

it("starts a second On repeat on another period, and names it by its period throughout", async () => {
  await renderHome("/?customize");
  const bar = within(screen.getByRole("region", { name: "Customize Home" }));
  await act(async () => fireEvent.click(bar.getByRole("button", { name: "Add panel" })));
  const dialog = await screen.findByRole("dialog", { name: "Add a panel" });
  const row = within(within(dialog).getByText("On repeat").closest("li")!);
  // The default board shows the last 30 days already.
  expect(row.getByRole("combobox", { name: "Period for On repeat" }).textContent).toContain("This year");
  await act(async () => fireEvent.click(row.getByRole("button", { name: "Add On repeat" })));
  expect(savedBoard()!.panels!.at(-1)).toMatchObject({ id: "repeat-2", period: "this-year" });

  const added = tile("On repeat (This year)");
  fireEvent.click(added.getByRole("button", { name: /^Move\s*On repeat \(This year\)$/ }));
  expect(bar.getByText("Choose where On repeat (This year) goes.")).toBeTruthy();
  fireEvent.click(added.getByRole("button", { name: /^Cancel move/ }));

  fireEvent.click(added.getByRole("button", { name: /^Hide\s*On repeat \(This year\)$/ }));
  expect(bar.getByRole("status").textContent).toBe("On repeat (This year) hidden.");
  const chip = within(bar.getByRole("group", { name: "Hidden panels" })).getByRole("button", { name: "Show On repeat (This year)" });
  expect(chip.textContent).toBe("On repeat (This year)");
  fireEvent.click(chip);
  expect(bar.getByRole("status").textContent).toBe("On repeat (This year) shown.");

  await act(async () => fireEvent.click(bar.getByRole("button", { name: "Reset" })));
  const confirm = within(await screen.findByRole("dialog", { name: "Reset Home?" }));
  expect(confirm.getByText(/\(\s*On repeat \(This year\)\) is removed/)).toBeTruthy();
});
