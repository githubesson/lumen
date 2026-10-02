import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import TrackContextMenu from "../src/components/TrackContextMenu";
import type { TrackListItem } from "../src/api";

const mock = vi.hoisted(() => ({
  role: "admin",
  getTrack: vi.fn(),
  deleteTrack: vi.fn(),
  reload: () => Promise.resolve(),
}));
vi.mock("../../core/src/api", async (original) => ({
  ...await original<typeof import("../../core/src/api")>(),
  api: { getTrack: mock.getTrack, deleteTrack: mock.deleteTrack },
}));
vi.mock("../src/context/Auth", () => ({
  useAuth: () => ({ me: { id: "user", role: mock.role, must_reset_password: false } }),
}));
vi.mock("../src/context/Player", () => ({ usePlayerControls: () => ({ play: vi.fn() }) }));
vi.mock("../src/context/Favorites", () => ({ useFavorites: () => ({ isFavorite: () => false, toggle: vi.fn() }) }));
vi.mock("../src/context/Playlists", () => ({
  usePlaylists: () => ({ data: [], error: null, loading: false, reload: mock.reload }),
}));

function Location() {
  const location = useLocation();
  return <output>{location.pathname + location.search}</output>;
}

function renderMenu(track: TrackListItem, props: { onEdit?: () => void; onMoveToAlbum?: () => void } = {}) {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <TrackContextMenu track={track} x={0} y={0} onClose={onClose} {...props} />
      <Location />
    </MemoryRouter>,
  );
  return onClose;
}

const item = (name: string) => screen.queryByRole("menuitem", { name });

beforeEach(() => {
  vi.clearAllMocks();
  mock.role = "admin";
});
afterEach(cleanup);

it("never offers an admin edits of a TIDAL track", async () => {
  renderMenu(
    { id: "tidal:1", title: "Streamed", duration_ms: 1, source: "tidal", album_id: "hidden", source_album_id: "77" },
    { onEdit: vi.fn(), onMoveToAlbum: vi.fn() },
  );
  await act(async () => {});
  expect(item("Edit metadata")).toBeNull();
  expect(item("Move to album…")).toBeNull();
  expect(item("Remove from library")).toBeNull();
  expect(item("View album")).toBeTruthy();
});

it("offers an admin edits and removal of a library track", async () => {
  renderMenu(
    { id: "t1", title: "Local", duration_ms: 1, source: "local", album_id: "a1" },
    { onEdit: vi.fn(), onMoveToAlbum: vi.fn() },
  );
  await act(async () => {});
  expect(item("Edit metadata")).toBeTruthy();
  expect(item("Move to album…")).toBeTruthy();
  expect(item("Remove from library")).toBeTruthy();
});

it("opens a TIDAL track's release, not its hidden library album", async () => {
  const onClose = renderMenu({
    id: "tidal:1", title: "Streamed", duration_ms: 1, source: "tidal", album_id: "hidden", source_album_id: "77",
  });
  await act(async () => { fireEvent.click(item("View album")!); });
  expect(screen.getByRole("status").textContent).toBe("/library?view=albums&tidalAlbum=77");
  expect(mock.getTrack).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

it("looks the album up when the row lacks it, and says when there is none", async () => {
  mock.getTrack.mockResolvedValueOnce({ id: "t1", source: "local", album_id: "a9" });
  renderMenu({ id: "t1", title: "Local", duration_ms: 1, source: "local", album_title: "Some album" });
  await act(async () => { fireEvent.click(item("View album")!); });
  expect(screen.getByRole("status").textContent).toBe("/library?view=albums&album=a9");

  cleanup();
  mock.getTrack.mockResolvedValueOnce({ id: "tidal:2", source: "tidal", album_id: "hidden" });
  renderMenu({ id: "tidal:2", title: "Streamed", duration_ms: 1, source: "tidal", album_id: "hidden" });
  await act(async () => { fireEvent.click(item("View album")!); });
  expect(screen.getByRole("alert").textContent).toBe("No album found for this track.");
  expect(screen.getByRole("status").textContent).toBe("/");
});

it("confirms deleting an own upload with the shared copy", async () => {
  mock.role = "user";
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderMenu({ id: "t1", title: "Mine", duration_ms: 1, source: "local", owned: true });
  await act(async () => { fireEvent.click(item("Delete from my library")!); });
  expect(confirm).toHaveBeenCalledWith(
    'Delete "Mine" from your library? This permanently removes the file you uploaded.',
  );
  expect(mock.deleteTrack).not.toHaveBeenCalled();
  confirm.mockRestore();
});
