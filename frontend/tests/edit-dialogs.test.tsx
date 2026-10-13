import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Album, TrackDetail } from "../src/api";
import { EditAlbumDialog } from "../src/components/edit/EditAlbumDialog";
import { EditTrackDialog } from "../src/components/edit/EditTrackDialog";

const mock = vi.hoisted(() => ({ updateAlbum: vi.fn(), getTrack: vi.fn(), updateTrack: vi.fn() }));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: mock,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// The page shows the cached album first, then swaps in the server's.
const cached: Album = {
  id: "a1", title: "Old title", artist_name: "Old artist", release_year: 2001,
  is_compilation: false, track_count: 3, duration_ms: 1, has_cover: false,
};
const fresh: Album = { ...cached, artist_name: "New artist", release_year: 2002 };

const dialog = (album: Album) => <EditAlbumDialog open album={album} onClose={() => {}} />;

async function openWith(album: Album) {
  const view = render(dialog(album));
  await waitFor(() => expect(screen.getByDisplayValue(album.title)).toBeTruthy());
  return view;
}

it("sends only what was edited when the album refreshes under the open form", async () => {
  mock.updateAlbum.mockResolvedValue({ ...fresh, title: "New title" });
  const { rerender } = await openWith(cached);
  fireEvent.change(screen.getByDisplayValue("Old title"), { target: { value: "New title" } });
  rerender(dialog(fresh));
  await act(async () => {
    fireEvent.submit(screen.getByDisplayValue("New title").closest("form")!);
  });
  expect(mock.updateAlbum).toHaveBeenCalledWith("a1", { title: "New title" });
});

it("shows the refreshed album when nothing has been edited yet", async () => {
  const { rerender } = await openWith(cached);
  rerender(dialog(fresh));
  expect(screen.getByDisplayValue("New artist")).toBeTruthy();
  expect(screen.getByDisplayValue("2002")).toBeTruthy();
});

it("loads the track into the form and sends only the edited fields", async () => {
  const track: TrackDetail = {
    id: "t1", source: "local", title: "Song", album_title: "LP", year: 1999, duration_ms: 1,
    format: "flac", file_size: 1, artists: [{ id: "ar1", name: "Band", role: "primary" }],
    has_cover: false, favorited: false,
  };
  mock.getTrack.mockResolvedValue(track);
  mock.updateTrack.mockResolvedValue({ ...track, genre: "Jazz" });
  const onSaved = vi.fn();
  render(<EditTrackDialog open trackId="t1" onClose={() => {}} onSaved={onSaved} />);
  await waitFor(() => expect(screen.getByDisplayValue("Song")).toBeTruthy());
  expect(screen.getByDisplayValue("Band")).toBeTruthy();

  const genre = screen.getByLabelText("Genre");
  fireEvent.change(genre, { target: { value: "Jazz" } });
  await act(async () => {
    fireEvent.submit(genre.closest("form")!);
  });
  expect(mock.updateTrack).toHaveBeenCalledWith("t1", { genre: "Jazz" });
  expect(onSaved).toHaveBeenCalledWith({ ...track, genre: "Jazz" });
});
