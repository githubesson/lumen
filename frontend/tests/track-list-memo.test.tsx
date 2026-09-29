import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TrackListItem } from "../src/api";
import TrackList from "../src/components/TrackList";
import { KeyBindingsProvider } from "../src/lib/keybindings";

const mock = vi.hoisted(() => ({
  player: { play: vi.fn(), current: null as TrackListItem | null, isPlaying: false },
  favorites: { isFavorite: () => false, toggle: vi.fn() },
  bind: vi.fn(),
}));
vi.mock("../src/context/Player", () => ({ usePlayer: () => mock.player, usePlayerControls: () => mock.player }));
vi.mock("../src/context/Favorites", () => ({ useFavorites: () => mock.favorites }));
vi.mock("../src/context/Auth", () => ({ useAuth: () => ({ me: null }) }));
vi.mock("../src/lib/useTrackContextMenu", () => ({ useTrackContextMenu: () => ({ bind: mock.bind, menu: null }) }));
vi.mock("../src/components/edit/EditTrackDialog", () => ({ EditTrackDialog: () => null }));
vi.mock("../src/components/edit/MoveToAlbumDialog", () => ({ MoveToAlbumDialog: () => null }));
vi.mock("../src/lib/useWindowedSlice", () => ({ useWindowedSlice: () => ({ start: 0, end: 50, topSpacerPx: 0, bottomSpacerPx: 0 }) }));

afterEach(() => { cleanup(); mock.player.current = null; mock.player.isPlaying = false; });

it("does not activate selection shortcuts on nonselectable lists", () => {
  render(<KeyBindingsProvider><TrackList tracks={[{ id: "a", title: "Song", duration_ms: 1000 }]} selectable={false} /></KeyBindingsProvider>);
  fireEvent.keyDown(window, { key: "v" });
  expect(screen.queryByRole("checkbox")).toBeNull();
});

it("skips unaffected rows with an extra column and still applies column changes", () => {
  const tracks: TrackListItem[] = [
    { id: "a", title: "Song A", duration_ms: 1000 },
    { id: "b", title: "Song B", duration_ms: 1000 },
  ];
  const renderExtra = vi.fn((track: TrackListItem) => track.id === "a" ? "12" : "0");
  const view = () => <TrackList tracks={tracks} selectable={false} showCover={false} extraColumn={{ header: "Plays", render: renderExtra }} />;
  const { rerender } = render(view());
  expect(renderExtra).toHaveBeenCalledTimes(2);
  renderExtra.mockClear();

  mock.player.current = tracks[0];
  mock.player.isPlaying = true;
  rerender(view());
  expect(renderExtra).toHaveBeenCalledTimes(1);
  expect(renderExtra).toHaveBeenCalledWith(tracks[0]);
  expect(screen.getByText("0")).toBeTruthy();

  rerender(<TrackList tracks={tracks} selectable={false} showCover={false} extraColumn={{ header: "Plays", render: () => "Updated" }} />);
  expect(screen.getAllByText("Updated")).toHaveLength(2);
});
