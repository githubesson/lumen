import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SearchAlbum, TidalAlbum, TidalArtist, TrackListItem } from "../src/api";
import { TidalAlbumDetailView } from "../src/pages/library/LibraryDetail";
import { clearResourceCache, writeCache } from "../src/lib/resourceCache";

const mock = vi.hoisted(() => ({ album: vi.fn(), artist: vi.fn(), role: "admin" }));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: { getTidalAlbum: mock.album, getTidalArtist: mock.artist },
}));
vi.mock("../src/context/Auth", () => ({ useAuth: () => ({ me: { id: "u", username: "maya", role: mock.role } }) }));
vi.mock("../src/components/TrackList", () => ({ default: () => null }));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => ({ play: vi.fn(), toggleShuffle: vi.fn(), shuffle: false }),
  useRemotePlayback: () => ({ targetDevice: null, commandPending: false }),
}));

const tidal = (n: number): TrackListItem => ({ id: `tidal:${n}`, title: `Song ${n}`, duration_ms: 200_000, source: "tidal" });
const saved = (n: number): TrackListItem => ({ id: `tr-${n}`, title: `Song ${n}`, duration_ms: 200_000, source: "local" });

function album(tracks: TrackListItem[], extra: Partial<TidalAlbum> = {}): TidalAlbum {
  const savedCount = tracks.filter((t) => t.source === "local").length;
  return {
    id: "381245570",
    title: "Low Tide Radio",
    artist: "Marisol Vey",
    artists: ["Marisol Vey"],
    track_count: tracks.length,
    duration_ms: tracks.length * 200_000,
    tracks,
    saved_count: savedCount,
    library_album_id: savedCount > 0 ? "al-low-tide" : undefined,
    ...extra,
  };
}

const onOpenAlbum = vi.fn();
const onOpenVersion = vi.fn();

async function show(data: TidalAlbum, artistId: string | null = null) {
  mock.album.mockResolvedValue(data);
  const view = render(
    <MemoryRouter>
      <TidalAlbumDetailView
        id={data.id}
        artistId={artistId}
        onBack={() => {}}
        onOpenAlbum={onOpenAlbum}
        onOpenVersion={onOpenVersion}
      />
    </MemoryRouter>,
  );
  await act(async () => {});
  const row = view.container.querySelector<HTMLElement>(".album-sleeve-more");
  const details = within(view.container.querySelector<HTMLElement>(".album-sleeve-details")!);
  return { row, rowButtons: row ? within(row).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent) : [], details };
}

beforeEach(() => {
  clearResourceCache();
  mock.role = "admin";
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// The loading frame holds one button-high row for an admin (see the sleeve's
// own test), so the loaded row must be exactly one control, in every state.

it("gives an admin one control in the actions row while there's something to download, and the library copy as a link", async () => {
  const unsaved = await show(album([tidal(1), tidal(2), tidal(3)]));
  expect(unsaved.rowButtons).toEqual(["Download album"]);
  expect(unsaved.details.queryByRole("button", { name: "Open in library" })).toBeNull();
  cleanup();

  const partial = await show(album([saved(1), tidal(2), tidal(3)]));
  expect(partial.rowButtons).toEqual(["Download 2 remaining"]);
  fireEvent.click(partial.details.getByRole("button", { name: "Open in library" }));
  expect(onOpenAlbum).toHaveBeenCalledWith({ kind: "local", id: "al-low-tide" });
  cleanup();

  // In progress: the count and an icon to cancel it, still one row.
  const queued = await show(album([saved(1), tidal(2), tidal(3)], { queued_count: 2 }));
  expect(queued.rowButtons).toEqual(["Downloading · 2 left", "Cancel download"]);
  expect(queued.details.getByRole("button", { name: "Open in library" })).toBeTruthy();
});

it("puts the library copy in the actions row once the whole release is saved", async () => {
  const full = await show(album([saved(1), saved(2), saved(3)]));
  expect(full.rowButtons).toEqual(["Open in library"]);
  expect(full.details.queryByRole("button", { name: "Open in library" })).toBeNull();
  fireEvent.click(within(full.row!).getByRole("button", { name: "Open in library" }));
  expect(onOpenAlbum).toHaveBeenCalledWith({ kind: "local", id: "al-low-tide" });
});

it("keeps an admin's row, disabled, when there's nothing to download and no library copy", async () => {
  const gone = (n: number): TrackListItem => ({ ...tidal(n), unavailable: true });
  const view = await show(album([gone(1), gone(2)]));
  expect(view.rowButtons).toEqual(["Nothing to download"]);
  expect(within(view.row!).getByRole("button").hasAttribute("disabled")).toBe(true);
  expect(view.details.queryByRole("button", { name: "Open in library" })).toBeNull();
});

it("gives a listener no actions row, which their loading frame doesn't hold, and the library copy as a link", async () => {
  mock.role = "user";
  for (const tracks of [[saved(1), tidal(2)], [saved(1), saved(2)]]) {
    const view = await show(album(tracks));
    expect(view.row).toBeNull();
    expect(view.details.getByRole("button", { name: "Open in library" })).toBeTruthy();
    cleanup();
  }
  const unsaved = await show(album([tidal(1)]));
  expect(unsaved.row).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in library" })).toBeNull();
});

const version = (id: string, extra: Partial<SearchAlbum>): SearchAlbum => ({
  id: `tidal:${id}`,
  source: "tidal",
  source_id: id,
  title: "Low Tide Radio",
  is_compilation: false,
  track_count: 9,
  duration_ms: 2_400_000,
  has_cover: true,
  ...extra,
});
const artist: TidalArtist = {
  albums: [
    version("381245572", { explicit: true, dolby_atmos: true }),
    version("381245571", {}),
    version("381245570", { explicit: true }),
  ],
  tracks: [],
};

it("switches between the versions the artist it was opened from lists, and has no switcher without an artist", async () => {
  writeCache("tidal-artist:77", artist);
  await show(album([tidal(1)]), "77");
  const picker = screen.getByRole("tablist", { name: "Version" });
  const tabs = within(picker).getAllByRole("tab");
  expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([
    ["Explicit", "true"],
    ["Clean", "false"],
    ["Dolby Atmos", "false"],
  ]);
  expect(tabs[2].getAttribute("title")).toBe("Dolby Atmos · Explicit · 9 tracks");
  fireEvent.click(tabs[1]);
  expect(onOpenVersion).toHaveBeenCalledWith("381245571", "77");
  cleanup();

  await show(album([tidal(1)]));
  expect(screen.queryByRole("tablist", { name: "Version" })).toBeNull();
  expect(mock.artist).not.toHaveBeenCalled();
});

it("asks the album's own artist for its versions when it wasn't opened from one", async () => {
  mock.artist.mockResolvedValue(artist);
  await show(album([tidal(1)], { artist_id: "77" }));
  expect(mock.artist).toHaveBeenCalledWith("77", expect.anything());
  const tabs = within(screen.getByRole("tablist", { name: "Version" })).getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual(["Explicit", "Clean", "Dolby Atmos"]);
  // The artist goes along, so the next version's page has the switcher at once.
  fireEvent.click(tabs[2]);
  expect(onOpenVersion).toHaveBeenCalledWith("381245572", "77");
});
