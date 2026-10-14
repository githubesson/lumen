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
  playlistTracks: vi.fn(), play: vi.fn(), bind: vi.fn(), playlists: [] as Playlist[],
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
  usePlaylists: () => ({ data: mock.playlists, loading: false, error: null, reload: vi.fn() }),
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
  expect(bar.getByRole("status").textContent).toBe("On repeat added.");
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
  await act(async () => fireEvent.click(tile("On repeat").getByRole("button", { name: /^Edit\s*On repeat$/ })));
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
  expect(tile("Heavy rotation")).toBeTruthy();
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
  await act(async () => fireEvent.click(tile("Your listening").getByRole("button", { name: /^Edit/ })));
  const settings = within(await screen.findByRole("dialog", { name: "Edit Your listening" }));
  await act(async () => fireEvent.click(settings.getByRole("button", { name: "Remove panel" })));
  expect(order()).toEqual(["recent", "genres"]);
  expect(savedBoard()!.panels!.map((p) => p.id)).toEqual(["recent", "genres"]);
  // Focus goes to the panel after it.
  expect(document.activeElement).toBe(within(panel("genres")!).getByRole("button", { name: /^Move/ }));

  const bar = within(screen.getByRole("region", { name: "Customize Home" }));
  await act(async () => fireEvent.click(bar.getByRole("button", { name: "Reset" })));
  const confirm = within(await screen.findByRole("dialog", { name: "Reset Home?" }));
  expect(confirm.getByText(/the 1 panel you added \(\s*Top genres\) is removed/)).toBeTruthy();
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
