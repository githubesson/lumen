import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReplayData, TrackListItem } from "../src/api";
import Home from "../src/pages/Home";
import { ThemeProvider } from "../src/context/Theme";
import { clearResourceCache, readCache } from "../src/lib/resourceCache";
import { replayQueries } from "@music-library/core/replay/replay";
import { stubBoardLayout } from "./board-fill-layout";

const mock = vi.hoisted(() => ({
  recent: vi.fn(), tracks: vi.fn(), replay: vi.fn(), getAlbum: vi.fn(),
  albumTracks: vi.fn(), artistTracks: vi.fn(), play: vi.fn(), bind: vi.fn(),
}));
vi.mock("../../core/src/api", async (original) => ({
  ...await original<typeof import("../../core/src/api")>(),
  api: {
    listRecent: mock.recent, listTracks: mock.tracks, getReplay: mock.replay, getAlbum: mock.getAlbum,
    listAlbumTracks: mock.albumTracks, listArtistTracks: mock.artistTracks,
  },
}));
vi.mock("../src/context/Auth", () => ({ useAuth: () => ({ me: { id: "user", username: "Listener" } }) }));
vi.mock("../src/context/Player", () => ({ usePlayerControls: () => ({ play: mock.play }) }));
vi.mock("../src/context/Favorites", () => ({
  useFavorites: () => ({ tracks: [], ids: new Set(), loaded: true, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../src/context/Playlists", () => ({
  usePlaylists: () => ({ data: [], loading: false, error: null, reload: vi.fn() }),
}));
vi.mock("../src/lib/useTrackContextMenu", () => ({ useTrackContextMenu: () => ({ bind: mock.bind, menu: null }) }));

const track = (id: string, artist: string, extra: Partial<TrackListItem> = {}): TrackListItem => ({
  id, title: `Track ${id}`, artist, duration_ms: 180_000, source: "local", ...extra,
});

function replay(top: (TrackListItem & { plays: number })[], artists: ReplayData["top_artists"] = []): ReplayData {
  return {
    summary: { total_plays: top.reduce((sum, t) => sum + t.plays, 0), total_ms: 0, unique_tracks: top.length, unique_artists: artists.length },
    top_tracks: top, top_artists: artists, top_albums: [], top_genres: [], activity: [], bucket: "day", available_years: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearResourceCache();
  localStorage.clear();
  mock.recent.mockResolvedValue([track("r1", "Halden Marsh")]);
  mock.tracks.mockResolvedValue([]);
  mock.getAlbum.mockResolvedValue(null);
  mock.replay.mockResolvedValue(replay([]));
});
afterEach(cleanup);

async function renderHome(url = "/") {
  const view = render(<MemoryRouter initialEntries={[url]}><ThemeProvider><Home /></ThemeProvider></MemoryRouter>);
  await act(async () => {});
  return view;
}

const panel = (id: string) => document.querySelector<HTMLElement>(`[data-panel="${id}"]`);

it("ranks what's on repeat with its plays, and plays a row or the whole list", async () => {
  const top = [track("a", "Kestrel Bay"), track("b", "Hana Okoro"), track("c", "Kestrel Bay")];
  mock.replay.mockResolvedValue(replay(top.map((t, i) => ({ ...t, plays: [9, 5, 2][i] }))));
  await renderHome();

  const repeat = within(panel("repeat")!);
  expect(repeat.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
    "1Play Track aKestrel Bay9 plays",
    "2Play Track bHana Okoro5 plays",
    "3Play Track cKestrel Bay2 plays",
  ]);
  expect(repeat.getByRole("link", { name: "view all →" }).getAttribute("href")).toBe("/replay?period=last-30");

  fireEvent.click(repeat.getByRole("button", { name: "Play Track b" }));
  expect(mock.play).toHaveBeenLastCalledWith(expect.objectContaining({ id: "b" }), [
    expect.objectContaining({ id: "a" }), expect.objectContaining({ id: "b" }), expect.objectContaining({ id: "c" }),
  ]);
  fireEvent.click(repeat.getByRole("button", { name: "Play all 3" }));
  expect(mock.play).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), expect.any(Array));
});

it("opens an unavailable row's menu on right-click, though the row doesn't play", async () => {
  const open = vi.fn();
  mock.bind.mockImplementation((t: TrackListItem) => (t.id === "gone" ? open : undefined));
  const gone = { ...track("gone", "Kestrel Bay", { unavailable: true }), plays: 3 };
  mock.replay.mockResolvedValue(replay([{ ...track("a", "Hana Okoro"), plays: 5 }, gone]));
  await renderHome();

  // The row's button covers the row. Disabled, it would get no mouse events
  // in Chrome, right-clicks included, so it's only aria-disabled.
  const button = within(panel("repeat")!).getByRole("button", { name: "Play Track gone" });
  expect(button.hasAttribute("disabled")).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(button);
  expect(mock.play).not.toHaveBeenCalled();
  fireEvent.contextMenu(button);
  expect(open).toHaveBeenCalledTimes(1);

  // A playable row is a plain button.
  expect(within(panel("repeat")!).getByRole("button", { name: "Play Track a" }).hasAttribute("aria-disabled")).toBe(false);
});

it("keeps Top artists hidden while a failed On repeat retries, until it has artists to show", async () => {
  const failed = "Could not load what you've had on repeat.";
  mock.replay.mockRejectedValueOnce(new Error("offline"));
  await renderHome();
  expect(within(panel("repeat")!).getByText(failed)).toBeTruthy();
  expect(panel("artists")).toBeNull();

  // A retry that fails again: On repeat holds its place with placeholders,
  // and Top artists doesn't flash in and out.
  const retry = (reply: Promise<ReplayData>) =>
    act(async () => {
      mock.replay.mockReturnValueOnce(reply);
      fireEvent.click(within(panel("repeat")!).getByRole("button", { name: "Retry on repeat" }));
    });
  const failing = deferred<ReplayData>();
  await retry(failing.promise);
  expect(panel("repeat")!.querySelectorAll(".board-placeholder")).toHaveLength(8);
  expect(panel("artists")).toBeNull();
  await act(async () => failing.reject(new Error("offline")));
  expect(within(panel("repeat")!).getByText(failed)).toBeTruthy();
  expect(panel("artists")).toBeNull();

  // One that lands brings both in.
  const landing = deferred<ReplayData>();
  await retry(landing.promise);
  expect(panel("artists")).toBeNull();
  const top = { ...track("a", "Kestrel Bay"), plays: 4 };
  await act(async () => landing.resolve(replay([top], [{ id: "ar-kestrel", name: "Kestrel Bay", plays: 4 }])));
  expect(within(panel("repeat")!).getByRole("button", { name: "Play Track a" })).toBeTruthy();
  expect(within(panel("artists")!).getByText("Kestrel Bay")).toBeTruthy();
});

it("leaves out On repeat and Top artists without plays this month, without flashing them on a revisit", async () => {
  const first = await renderHome();
  expect(panel("repeat")).toBeNull();
  expect(panel("artists")).toBeNull();
  first.unmount();

  // The cached answer says there's nothing; the refresh behind it is slow.
  mock.replay.mockReturnValue(new Promise(() => {}));
  await renderHome();
  expect(panel("repeat")).toBeNull();
  expect(panel("artists")).toBeNull();
});

it("holds On repeat's shape with placeholders on a first visit", async () => {
  mock.replay.mockReturnValue(new Promise(() => {}));
  await renderHome();
  const repeat = panel("repeat")!;
  expect(repeat.querySelectorAll(".board-placeholder")).toHaveLength(8);
  expect(within(repeat).getByRole("button", { name: "Play all" })).toHaveProperty("disabled", true);
  expect(within(repeat).getByRole("status").getAttribute("aria-busy")).toBe("true");
});

it("asks for the last 30 days by day, under the key Replay reads", async () => {
  await renderHome();
  const { daily } = replayQueries({ kind: "last-30" });
  // The window moves with the clock, so its days are what must match.
  const [params] = mock.replay.mock.calls[0];
  expect(params).toEqual({ from: expect.any(String), to: expect.any(String), bucket: "day" });
  expect([params.from.slice(0, 10), params.to.slice(0, 10)]).toEqual([
    daily.params.from!.slice(0, 10),
    daily.params.to!.slice(0, 10),
  ]);
  expect(readCache(daily.cacheKey)).toEqual(replay([]));
});

it("opens a top artist's page when they have one, and plays them when they don't", async () => {
  const library = track("l1", "Halden Marsh");
  const streamed = track("s1", "Halden Marsh, Earth, Wind & Fire", {
    source: "tidal",
    cover_url: "https://example.test/c.jpg",
    primary_artists: [
      { id: "ar-halden", name: "Halden Marsh", has_page: true },
      { id: "ar-ewf", name: "Earth, Wind & Fire", has_page: false },
    ],
  } as Partial<TrackListItem>);
  mock.replay.mockResolvedValue(
    replay([{ ...streamed, plays: 12 }, { ...library, plays: 3 }], [
      { id: "ar-ewf", name: "Earth, Wind & Fire", plays: 12, has_page: false },
      { id: "ar-halden", name: "Halden Marsh", plays: 15, has_page: true },
      { id: "ar-gone", name: "Gone", plays: 2, has_page: false },
    ]),
  );
  await renderHome();
  const artists = within(panel("artists")!);
  expect(artists.getByText("12 plays")).toBeTruthy();

  // A page: the tile opens it, and its glyph is the arrow.
  const open = artists.getByRole("link", { name: "Open Halden Marsh" });
  expect(open.getAttribute("href")).toBe("/library?view=artists&artist=ar-halden");
  expect(artists.queryByRole("button", { name: "Play Halden Marsh" })).toBeNull();
  expect(open.closest("li")!.querySelector('[data-action="open"]')).not.toBeNull();

  // Streamed only: no page, so the tile plays their tracks on repeat,
  // matched though the name holds commas.
  const play = artists.getByRole("button", { name: "Play Earth, Wind & Fire" });
  expect(play.closest("li")!.querySelector('[data-action="play"]')).not.toBeNull();
  await act(async () => fireEvent.click(play));
  expect(mock.artistTracks).not.toHaveBeenCalled();
  expect(mock.play).toHaveBeenLastCalledWith(expect.objectContaining({ id: "s1" }), [expect.objectContaining({ id: "s1" })]);

  // Neither a page nor anything to play: plain text, no glyph.
  const gone = artists.getByText("Gone");
  expect(gone.closest("a, button")).toBeNull();
  expect(gone.closest("li")!.querySelector("[data-action]")).toBeNull();
});

it("opens an album from its card and plays it from the card's button", async () => {
  mock.tracks.mockResolvedValue([
    track("1", "Halden Marsh", { album_id: "al-1", album_title: "Weather" }),
    track("2", "Halden Marsh, Hana Okoro", { album_id: "al-1", album_title: "Weather" }),
  ]);
  const albumTracks = [track("1", "Halden Marsh"), track("2", "Halden Marsh")];
  mock.albumTracks.mockResolvedValue(albumTracks);
  await renderHome();
  const albums = within(panel("albums")!);
  // One card for the album, featured guest or not.
  expect(albums.getAllByRole("link", { name: "Weather" })).toHaveLength(1);
  expect(albums.getByRole("link", { name: "Weather" }).getAttribute("href")).toContain("album=al-1");
  // Tab reaches the card's play button right after its link.
  const link = albums.getByRole("link", { name: "Weather" });
  const button = albums.getByRole("button", { name: "Play Weather" });
  expect(link.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  await act(async () => fireEvent.click(albums.getByRole("button", { name: "Play Weather" })));
  expect(mock.albumTracks).toHaveBeenCalledWith("al-1", expect.anything());
  expect(mock.play).toHaveBeenLastCalledWith(albumTracks[0], albumTracks);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Each panel and the columns it spans on the wide board, in order. */
const boardShape = () =>
  [...document.querySelectorAll<HTMLElement>(".board > *")]
    .map((el) => `${el.dataset.panel ?? "resume"}:${el.style.getPropertyValue("--board-span")}`)
    .join(" ");

it("holds the full board until every list has settled, then changes shape once", async () => {
  // Favorites and playlists are known to be empty from the start, and the
  // library has no albums; only Replay is slow.
  const replayReply = deferred<ReplayData>();
  mock.replay.mockReturnValue(replayReply.promise);
  const shapes: string[] = [];
  const record = () => {
    const shape = boardShape();
    if (shape && shapes.at(-1) !== shape) shapes.push(shape);
  };
  const observer = new MutationObserver(record);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });

  await renderHome();
  record();
  // Recently played has arrived; the empty lists still hold their places.
  expect(panel("recent")!.querySelector(".board-placeholder")).toBeNull();
  for (const id of ["favorites", "albums", "playlists"]) {
    expect(panel(id)!.querySelector(".board-placeholder, .card-placeholder"), id).not.toBeNull();
  }

  const top = { ...track("a", "Kestrel Bay"), plays: 4 };
  await act(async () => replayReply.resolve(replay([top], [{ id: "ar-kestrel", name: "Kestrel Bay", plays: 4 }])));
  record();
  observer.disconnect();

  expect(shapes).toEqual([
    "resume:4 repeat:2 recent:2 favorites:2 albums:4 playlists:2 artists:6",
    "resume:4 repeat:2 recent:4 artists:6",
  ]);
});

it("says why an album didn't play, in its panel", async () => {
  mock.tracks.mockResolvedValue([track("1", "Halden Marsh", { album_id: "al-1", album_title: "Weather" })]);
  mock.albumTracks.mockRejectedValue(new TypeError("Failed to fetch"));
  await renderHome();
  const albums = within(panel("albums")!);
  await act(async () => fireEvent.click(albums.getByRole("button", { name: "Play Weather" })));
  expect(albums.getByRole("alert").textContent).toBe("Could not play Weather. Check your connection and try again.");
  expect(mock.play).not.toHaveBeenCalled();

  // The next Play clears it.
  mock.albumTracks.mockResolvedValue([track("1", "Halden Marsh")]);
  await act(async () => fireEvent.click(albums.getByRole("button", { name: "Play Weather" })));
  expect(albums.queryByRole("alert")).toBeNull();
  expect(mock.play).toHaveBeenCalled();
});

/** Saves an arrangement the way the Theme context does. */
const arrange = (homeBoard: { slots: string[]; hidden: string[] }) =>
  localStorage.setItem("lumen.tweaks", JSON.stringify({ homeBoard }));
const savedBoard = () => JSON.parse(localStorage.getItem("lumen.tweaks") ?? "{}").homeBoard;
const slotOf = (id: string) => panel(id)?.dataset.slot;

const withAlbum = () =>
  mock.tracks.mockResolvedValue([track("1", "Halden Marsh", { album_id: "al-1", album_title: "Weather" })]);

it("puts each panel in the slot it was moved to, and leaves hidden ones off", async () => {
  withAlbum();
  arrange({
    slots: ["resume", "repeat", "albums", "favorites", "recent", "playlists", "artists"],
    hidden: ["resume"],
  });
  await renderHome();
  expect(slotOf("albums")).toBe("recent");
  expect(slotOf("recent")).toBe("albums");
  expect(panel("resume")).toBeNull();
  // Not customizing: the panels work as usual.
  expect(panel("albums")!.querySelector(".board-slot-body")!.hasAttribute("inert")).toBe(false);
  expect(within(panel("albums")!).getByRole("button", { name: "Play Weather" })).toBeTruthy();
});

it("swaps and hides panels while customizing, and saves the arrangement", async () => {
  withAlbum();
  await renderHome("/?customize");
  const bar = within(screen.getByRole("region", { name: "Customize Home" }));
  const tile = (name: string) => within(screen.getByRole("group", { name }));
  // The panels underneath are inert while they're arranged.
  expect(panel("recent")!.querySelector(".board-slot-body")!.hasAttribute("inert")).toBe(true);
  // Empty lists are on the board too, so they can be moved or hidden.
  expect(tile("Your favorites").getByText("Shows up once it has something")).toBeTruthy();

  fireEvent.click(tile("Albums").getByRole("button", { name: /^Move\s*Albums$/ }));
  expect(bar.getByText("Choose where Albums goes.")).toBeTruthy();
  fireEvent.click(tile("Recently played").getByRole("button", { name: /^Swap here\s*with Recently played$/ }));
  expect(slotOf("albums")).toBe("recent");
  expect(slotOf("recent")).toBe("albums");
  expect(savedBoard()).toEqual({
    slots: ["resume", "repeat", "albums", "favorites", "recent", "playlists", "artists"],
    hidden: [],
  });
  expect(bar.getByRole("status").textContent).toBe("Swapped Albums and Recently played.");
  // Focus stays with the panel that moved.
  expect(document.activeElement).toBe(tile("Albums").getByRole("button", { name: /^Move\s*Albums$/ }));

  fireEvent.click(tile("Albums").getByRole("button", { name: /^Hide\s*Albums$/ }));
  expect(panel("albums")).toBeNull();
  expect(savedBoard().hidden).toEqual(["albums"]);
  // Showing it again while another panel is picked ends that Move, and
  // focus lands on the shown panel's Move button.
  fireEvent.click(tile("Playlists").getByRole("button", { name: /^Move\s*Playlists$/ }));
  fireEvent.click(within(bar.getByRole("group", { name: "Hidden panels" })).getByRole("button", { name: "Show Albums" }));
  expect(slotOf("albums")).toBe("recent");
  expect(document.activeElement).toBe(tile("Albums").getByRole("button", { name: /^Move\s*Albums$/ }));
  expect(screen.queryByRole("button", { name: /^Swap here/ })).toBeNull();

  fireEvent.click(bar.getByRole("button", { name: "Reset" }));
  expect(slotOf("albums")).toBe("albums");
  expect(savedBoard()).toBeUndefined();

  fireEvent.click(bar.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("region", { name: "Customize Home" })).toBeNull();
  expect(panel("favorites")).toBeNull();
});

it("swaps two panels dropped one on the other", async () => {
  withAlbum();
  await renderHome("/?customize");
  const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(panel("albums")!, { dataTransfer });
  fireEvent.dragEnter(panel("resume")!, { dataTransfer });
  expect(panel("resume")!.hasAttribute("data-target")).toBe(true);
  // Crossing into the tile's children doesn't drop the highlight, even
  // with no relatedTarget (as Safari reports it).
  const label = panel("resume")!.querySelector(".board-slot-name")!;
  fireEvent.dragEnter(label, { dataTransfer });
  fireEvent.dragLeave(panel("resume")!, { dataTransfer });
  expect(panel("resume")!.hasAttribute("data-target")).toBe(true);
  fireEvent.dragOver(label, { dataTransfer });
  fireEvent.drop(label, { dataTransfer });
  expect(slotOf("albums")).toBe("resume");
  expect(slotOf("resume")).toBe("albums");
  expect(savedBoard().slots.slice(0, 5)).toEqual(["albums", "repeat", "recent", "favorites", "resume"]);
});

it("keeps both of two changes made before the first one's transition runs", async () => {
  // A view transition calls its update a frame later; hold them all.
  const updates: (() => void)[] = [];
  const settled = Promise.resolve();
  Object.assign(document, {
    startViewTransition: (update: () => void) => {
      updates.push(update);
      return { ready: settled, finished: settled, updateCallbackDone: settled };
    },
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  try {
    withAlbum();
    await renderHome("/?customize");
    const tile = (name: string) => within(screen.getByRole("group", { name }));
    fireEvent.click(tile("Albums").getByRole("button", { name: /^Hide\s*Albums$/ }));
    fireEvent.click(tile("Playlists").getByRole("button", { name: /^Hide\s*Playlists$/ }));
    act(() => updates.splice(0).forEach((update) => update()));
    expect(panel("albums")).toBeNull();
    expect(panel("playlists")).toBeNull();
    expect(savedBoard().hidden).toEqual(["albums", "playlists"]);
  } finally {
    delete (document as { startViewTransition?: unknown }).startViewTransition;
    vi.unstubAllGlobals();
  }
});

it("offers a way back when every panel is hidden", async () => {
  arrange({ slots: [], hidden: ["resume", "repeat", "recent", "favorites", "albums", "playlists", "artists"] });
  await renderHome();
  expect(screen.getByText("Every panel on Home is hidden.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Customize Home" }));
  expect(screen.getByRole("region", { name: "Customize Home" })).toBeTruthy();
});

it("fills a roomier slot with more recently played, asking for more to do it", async () => {
  const played = Array.from({ length: 60 }, (_, i) => track(`r${i}`, "Halden Marsh"));
  mock.recent.mockImplementation((limit: number) => Promise.resolve(played.slice(0, limit)));
  // Room for 23 rows: more than the usual 20 recently played.
  const restore = stubBoardLayout({ recent: 23 * 52 });
  try {
    await renderHome();
    await act(async () => {});
    expect(mock.recent.mock.calls.map(([limit]) => limit)).toEqual([20, 40]);
    expect(within(panel("recent")!).getAllByRole("listitem")).toHaveLength(23);
  } finally {
    restore();
  }
});

it("shows the usual rows without room to spare", async () => {
  mock.recent.mockResolvedValue(Array.from({ length: 20 }, (_, i) => track(`r${i}`, "Halden Marsh")));
  await renderHome();
  expect(within(panel("recent")!).getAllByRole("listitem")).toHaveLength(5);
  expect(mock.recent.mock.calls.map(([limit]) => limit)).toEqual([20]);
});
