import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReplayData, TrackListItem } from "../src/api";
import Home from "../src/pages/Home";
import { clearResourceCache } from "../src/lib/resourceCache";

const mock = vi.hoisted(() => ({
  recent: vi.fn(), tracks: vi.fn(), replay: vi.fn(), getAlbum: vi.fn(),
  albumTracks: vi.fn(), artistTracks: vi.fn(), play: vi.fn(),
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
vi.mock("../src/lib/useTrackContextMenu", () => ({ useTrackContextMenu: () => ({ bind: () => undefined, menu: null }) }));

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
  mock.recent.mockResolvedValue([track("r1", "Halden Marsh")]);
  mock.tracks.mockResolvedValue([]);
  mock.getAlbum.mockResolvedValue(null);
  mock.replay.mockResolvedValue(replay([]));
});
afterEach(cleanup);

async function renderHome() {
  const view = render(<MemoryRouter><Home /></MemoryRouter>);
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

it("plays a top artist's library tracks, or their tracks on repeat when the library has none", async () => {
  const streamed = track("s1", "Halden Marsh, Kestrel Bay", { source: "tidal", cover_url: "https://example.test/c.jpg" });
  mock.replay.mockResolvedValue(
    replay([{ ...streamed, plays: 12 }], [{ id: "ar-kestrel", name: "Kestrel Bay", plays: 12 }]),
  );
  await renderHome();
  const artists = within(panel("artists")!);
  expect(artists.getByText("12 plays")).toBeTruthy();
  const play = artists.getByRole("button", { name: "Play Kestrel Bay" });

  mock.artistTracks.mockResolvedValue([]);
  await act(async () => fireEvent.click(play));
  expect(mock.artistTracks).toHaveBeenCalledWith("ar-kestrel", expect.anything());
  expect(mock.play).toHaveBeenLastCalledWith(expect.objectContaining({ id: "s1" }), [expect.objectContaining({ id: "s1" })]);

  const library = [track("l1", "Kestrel Bay"), track("l2", "Kestrel Bay")];
  mock.artistTracks.mockResolvedValue(library);
  await act(async () => fireEvent.click(play));
  expect(mock.play).toHaveBeenLastCalledWith(library[0], library);
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
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
