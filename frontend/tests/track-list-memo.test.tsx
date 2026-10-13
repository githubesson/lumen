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
vi.mock("../src/lib/useTrackContextMenu", async (original) => ({
  ...await original<typeof import("../src/lib/useTrackContextMenu")>(),
  useTrackContextMenu: () => ({ bind: mock.bind, menu: null }),
}));
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

const artistLines = (container: HTMLElement) =>
  [...container.querySelectorAll(".track-sub")].map((line) => line.textContent);

it("leaves out the artist line on rows credited to the page's own artist", () => {
  const tracks: TrackListItem[] = [
    { id: "a", title: "Solo", artist: "Band", duration_ms: 1000 },
    { id: "b", title: "Duet", artist: "Band, Guest", duration_ms: 1000 },
    { id: "c", title: "Same, other case", artist: "band", duration_ms: 1000 },
  ];
  const { container, rerender } = render(<TrackList tracks={tracks} selectable={false} omitArtists={["Band"]} />);
  expect(artistLines(container)).toEqual(["Band, Guest"]);
  // Without a page artist every row names its own.
  rerender(<TrackList tracks={tracks} selectable={false} />);
  expect(artistLines(container)).toEqual(["Band", "Band, Guest", "band"]);
});

it("on a release billed to several artists, names a row's artists only when someone else is on it", () => {
  const tracks: TrackListItem[] = [
    { id: "a", title: "First alone", artist: "Halden Marsh", duration_ms: 1000 },
    { id: "b", title: "Both", artist: "Halden Marsh, Earth, Wind & Fire", duration_ms: 1000 },
    { id: "c", title: "Second alone", artist: "earth, wind & fire", duration_ms: 1000 },
    { id: "d", title: "With a guest", artist: "Earth, Wind & Fire, Hana Okoro", duration_ms: 1000 },
    { id: "e", title: "Part of a name", artist: "Earth", duration_ms: 1000 },
  ];
  const { container } = render(
    <TrackList tracks={tracks} selectable={false} omitArtists={["Halden Marsh", "Earth, Wind & Fire"]} />,
  );
  expect(artistLines(container)).toEqual(["Earth, Wind & Fire, Hana Okoro", "Earth"]);
});

it("opens the selection menu for a right-click inside a selection, and a row's own menu outside it", () => {
  const open = vi.fn();
  mock.bind.mockReturnValue(open);
  const tracks: TrackListItem[] = ["a", "b", "c"].map((id) => ({ id, title: `Song ${id}`, duration_ms: 1000, source: "local" }));
  render(<KeyBindingsProvider><TrackList tracks={tracks} /></KeyBindingsProvider>);
  const row = (id: string) => screen.getByTitle(`Song ${id}`).closest("tr")!;

  fireEvent.contextMenu(row("a"));
  expect(mock.bind.mock.lastCall?.[1].selection).toBeUndefined();

  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(row("a"));
  fireEvent.click(row("c"));
  fireEvent.contextMenu(row("c"));
  expect(mock.bind.mock.lastCall?.[0]).toBe(tracks[2]);
  expect(mock.bind.mock.lastCall?.[1].selection).toMatchObject({ tracks: [tracks[0], tracks[2]], exportDisabledReason: undefined });
  expect(open).toHaveBeenCalledTimes(2);

  fireEvent.contextMenu(row("b"));
  expect(mock.bind.mock.lastCall?.[0]).toBe(tracks[1]);
  expect(mock.bind.mock.lastCall?.[1].selection).toBeUndefined();

  // A selection of one is just that track.
  fireEvent.click(row("c"));
  fireEvent.contextMenu(row("a"));
  expect(mock.bind.mock.lastCall?.[1].selection).toBeUndefined();
});

it("lets the click that closes a menu only close it: no play, no selection change", () => {
  const tracks: TrackListItem[] = ["a", "b"].map((id) => ({ id, title: `Song ${id}`, duration_ms: 1000, source: "local" }));
  render(<KeyBindingsProvider><TrackList tracks={tracks} /></KeyBindingsProvider>);
  const title = (id: string) => screen.getByTitle(`Song ${id}`);
  const press = (element: Element) => {
    fireEvent.mouseDown(element);
    fireEvent.mouseUp(element);
    fireEvent.click(element);
  };
  const menu = document.createElement("div");
  menu.className = "ctx-menu";

  document.body.append(menu);
  press(title("a"));
  expect(mock.player.play).not.toHaveBeenCalled();
  menu.remove();
  press(title("a"));
  expect(mock.player.play).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  press(title("a"));
  expect(screen.getByText("1 selected")).toBeTruthy();
  document.body.append(menu);
  press(title("b"));
  expect(screen.getByText("1 selected")).toBeTruthy();
  menu.remove();
});
