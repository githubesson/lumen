import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TidalAlbum, TrackListItem } from "../src/api";
import { TidalAlbumDetailView } from "../src/pages/library/LibraryDetail";
import { clearResourceCache } from "../src/lib/resourceCache";

const mock = vi.hoisted(() => ({ album: vi.fn(), role: "admin" }));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: { getTidalAlbum: mock.album },
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

async function show(data: TidalAlbum) {
  mock.album.mockResolvedValue(data);
  const view = render(
    <MemoryRouter>
      <TidalAlbumDetailView id={data.id} onBack={() => {}} onOpenAlbum={onOpenAlbum} />
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
