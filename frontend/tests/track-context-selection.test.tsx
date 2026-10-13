import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import TrackContextMenu, { type TrackMenuSelection } from "../src/components/TrackContextMenu";
import { KeyBindingsProvider, useKey } from "../src/lib/keybindings";
import { useTrackContextMenu } from "../src/lib/useTrackContextMenu";
import type { Playlist, TrackListItem } from "../src/api";

const mock = vi.hoisted(() => ({
  add: vi.fn(),
  play: vi.fn(),
  toggle: vi.fn(),
  favorites: new Set<string>(),
  reload: () => Promise.resolve(),
  playlists: [] as Playlist[],
}));
vi.mock("../../core/src/api", async (original) => ({
  ...await original<typeof import("../../core/src/api")>(),
  api: { addPlaylistTracks: mock.add },
}));
vi.mock("../src/context/Auth", () => ({
  useAuth: () => ({ me: { id: "user", role: "admin", must_reset_password: false } }),
}));
vi.mock("../src/context/Player", () => ({ usePlayerControls: () => ({ play: mock.play }) }));
vi.mock("../src/context/Favorites", () => ({
  useFavorites: () => ({ isFavorite: (id: string) => mock.favorites.has(id), toggle: mock.toggle }),
}));
vi.mock("../src/context/Playlists", () => ({
  usePlaylists: () => ({ data: mock.playlists, error: null, loading: false, reload: mock.reload }),
}));

const playlist = (id: string, name: string, extra: Partial<Playlist> = {}): Playlist => ({
  id, owner_id: "user", name, visibility: "private", is_smart: false,
  effective_role: "owner", created_at: "", updated_at: "", ...extra,
});

const tracks: TrackListItem[] = [
  { id: "a", title: "First", artist: "Ada", album_id: "al-1", duration_ms: 1, source: "local" },
  { id: "b", title: "Gone", artist: "Ben", album_id: "al-2", duration_ms: 1, source: "tidal", unavailable: true },
  { id: "c", title: "Third", artist: "Ada", album_id: "al-1", duration_ms: 1, source: "local" },
];

function renderMenu(selection?: Partial<TrackMenuSelection>, track = tracks[0]) {
  const onClose = vi.fn();
  const props = {
    track,
    x: 0,
    y: 0,
    onClose,
    onInfo: vi.fn(),
    onShare: vi.fn(),
    onEdit: vi.fn(),
    onMoveToAlbum: vi.fn(),
    selection: selection ? { tracks, ...selection } : undefined,
  };
  render(<MemoryRouter><TrackContextMenu {...props} /></MemoryRouter>);
  return onClose;
}

const item = (name: string) => screen.queryByRole("menuitem", { name });

beforeEach(() => {
  vi.clearAllMocks();
  mock.favorites = new Set();
  mock.playlists = [playlist("mine", "Mine"), playlist("shared", "Shared", { effective_role: "editor", owner_name: "jonas" })];
  mock.add.mockResolvedValue(undefined);
  mock.toggle.mockResolvedValue(undefined);
});
afterEach(cleanup);

it("names the selection and offers only what applies to every track", async () => {
  renderMenu({ onExport: vi.fn() });
  await act(async () => {});
  expect(screen.getByRole("menu", { name: "3 tracks" })).toBeTruthy();
  expect(screen.getByText("Ada, Ben")).toBeTruthy();
  expect(screen.getByText("Add 3 tracks to playlist")).toBeTruthy();
  expect(item("Play")).toBeTruthy();
  expect(screen.getByRole("menuitemcheckbox", { name: "Favorite" })).toBeTruthy();
  expect(item("Export")).toBeTruthy();
  for (const name of ["Share", "Download", "View album", "Song info", "Edit metadata", "Move to album…", "Remove from library"]) {
    expect(item(name)).toBeNull();
  }
});

it("keeps the one-track card for a right-click outside a selection of two or more", async () => {
  renderMenu({ tracks: [tracks[0]] });
  await act(async () => {});
  expect(screen.getByRole("menu", { name: "First" })).toBeTruthy();
  expect(screen.getByText("Ada")).toBeTruthy();
  for (const name of ["Play", "Share", "Download", "View album", "Song info", "Edit metadata", "Move to album…", "Remove from library"]) {
    expect(item(name)).toBeTruthy();
  }
  expect(screen.getByText("Add to playlist")).toBeTruthy();
});

it("plays the selection's playable tracks, from the first", async () => {
  const onClose = renderMenu({});
  fireEvent.click(item("Play")!);
  expect(mock.play).toHaveBeenCalledWith(tracks[0], [tracks[0], tracks[2]]);
  expect(onClose).toHaveBeenCalled();
});

it("favorites the rest of a partly favorited selection, and unfavorites a fully favorited one", async () => {
  mock.favorites = new Set(["a"]);
  renderMenu({});
  const favorite = screen.getByRole("menuitemcheckbox", { name: "Favorite" });
  expect(favorite.getAttribute("aria-checked")).toBe("mixed");
  await act(async () => { fireEvent.click(favorite); });
  expect(mock.toggle.mock.calls.map(([id]) => id)).toEqual(["b", "c"]);

  cleanup();
  mock.toggle.mockClear();
  mock.favorites = new Set(["a", "b", "c"]);
  renderMenu({});
  const all = screen.getByRole("menuitemcheckbox", { name: "Favorite" });
  expect(all.getAttribute("aria-checked")).toBe("true");
  await act(async () => { fireEvent.click(all); });
  expect(mock.toggle.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c"]);
});

it("exports through the selection's own export, unless nothing can be", async () => {
  const onExport = vi.fn();
  const onClose = renderMenu({ onExport });
  fireEvent.click(item("Export")!);
  expect(onExport).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalled();

  cleanup();
  renderMenu({ onExport, exportDisabledReason: "Selected streaming tracks cannot be exported as files." });
  const disabled = item("Export") as HTMLButtonElement;
  expect(disabled.disabled).toBe(true);
  expect(disabled.title).toBe("Selected streaming tracks cannot be exported as files.");
});

it("adds every selected track, once each, in one click", async () => {
  renderMenu({ tracks: [...tracks, tracks[0]] });
  await act(async () => {});
  await act(async () => { fireEvent.click(item("Mine")!); });
  expect(mock.add).toHaveBeenCalledWith("mine", ["a", "b", "c"]);
  expect((item("Mine") as HTMLButtonElement).disabled).toBe(true);
});

it("names the owner of a playlist someone else shared, and only that one", async () => {
  renderMenu({});
  await act(async () => {});
  const group = screen.getByRole("group", { name: "Add 3 tracks to playlist" });
  expect(within(group).getByRole("menuitem", { name: "Shared jonas" })).toBeTruthy();
  expect(within(group).getByRole("menuitem", { name: "Mine" })).toBeTruthy();
});

it("focuses the first item on open and moves with the arrow keys, along the icon row and down the list", async () => {
  renderMenu({ onExport: vi.fn() });
  await act(async () => {});
  const menu = screen.getByRole("menu");
  // Opened with the pointer, focus doesn't show yet: the first arrow key
  // highlights the first item instead of skipping it.
  expect(document.activeElement).toBe(item("Play"));
  expect(menu.hasAttribute("data-pointer-open")).toBe(true);
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(item("Play"));
  expect(menu.hasAttribute("data-pointer-open")).toBe(false);
  fireEvent.keyDown(menu, { key: "ArrowRight" });
  expect(document.activeElement).toBe(screen.getByRole("menuitemcheckbox", { name: "Favorite" }));
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(item("Mine"));
  fireEvent.keyDown(menu, { key: "End" });
  expect(document.activeElement).toBe(item("Shared jonas"));
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(item("Play"));
  fireEvent.keyDown(menu, { key: "ArrowUp" });
  expect(document.activeElement).toBe(item("Shared jonas"));
});

it("shows the first item from the start when opened from the keyboard", async () => {
  render(<MemoryRouter><TrackContextMenu track={tracks[0]} x={0} y={0} byKeyboard onClose={vi.fn()} /></MemoryRouter>);
  await act(async () => {});
  const menu = screen.getByRole("menu");
  expect(menu.hasAttribute("data-pointer-open")).toBe(false);
  expect(document.activeElement).toBe(item("Play"));
  fireEvent.keyDown(menu, { key: "ArrowRight" });
  expect(document.activeElement).toBe(screen.getByRole("menuitemcheckbox", { name: "Favorite" }));
});

describe("Tab closes the menu and focus goes back", () => {
  function Harness({ focusFirst }: { focusFirst: boolean }) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const [open, setOpen] = useState(false);
    return (
      <MemoryRouter>
        <table><tbody>
          <tr ref={setAnchor} data-testid="row">
            <td hidden><input type="checkbox" aria-label="Select row" tabIndex={-1} /></td>
            <td><button>Play row</button></td>
            <td><button>Favorite row</button></td>
          </tr>
        </tbody></table>
        <button onClick={() => {
          if (focusFirst) (anchor?.querySelectorAll("button")[1] as HTMLButtonElement).focus();
          setOpen(true);
        }}>Open</button>
        {open && <TrackContextMenu track={tracks[0]} x={0} y={0} anchor={anchor} onClose={() => setOpen(false)} />}
      </MemoryRouter>
    );
  }

  it("to the right-clicked row's first control, since the row itself can't take focus", async () => {
    // Like a right-click on a row, this open leaves focus on the page (a
    // synthetic click doesn't focus the button).
    render(<Harness focusFirst={false} />);
    fireEvent.click(screen.getByText("Open"));
    await act(async () => {});
    expect(screen.getByRole("menu").contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByText("Play row"));
  });

  it("to what had focus inside the row, also on Shift+Tab", async () => {
    render(<Harness focusFirst />);
    fireEvent.click(screen.getByText("Open"));
    await act(async () => {});
    expect(screen.getByRole("menu").contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab", shiftKey: true });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByText("Favorite row"));
  });
});

it("resumes a batched add after a failed batch instead of adding the first ones twice", async () => {
  const many = Array.from({ length: 1500 }, (_, i): TrackListItem => ({ id: `t${i}`, title: `T${i}`, duration_ms: 1 }));
  mock.add.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Offline"));
  renderMenu({ tracks: many });
  await act(async () => {});
  await act(async () => { fireEvent.click(item("Mine")!); });
  expect(mock.add.mock.calls.map(([, ids]) => [ids[0], ids.length])).toEqual([["t0", 1000], ["t1000", 500]]);
  expect(screen.getByRole("alert").textContent).toContain("1000 of 1500 were added");
  expect((item("Mine") as HTMLButtonElement).disabled).toBe(false);

  await act(async () => { fireEvent.click(item("Mine")!); });
  expect(mock.add.mock.calls.slice(2).map(([, ids]) => [ids[0], ids.length])).toEqual([["t1000", 500]]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect((item("Mine") as HTMLButtonElement).disabled).toBe(true);
});

describe("a menu opened for other tracks starts over", () => {
  const many = Array.from({ length: 1500 }, (_, i): TrackListItem => ({ id: `t${i}`, title: `T${i}`, duration_ms: 1 }));
  const failSecondBatch = () =>
    mock.add.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Offline"));

  it("doesn't resume a failed add for a different set of tracks", async () => {
    failSecondBatch();
    const props = { track: many[0], x: 0, y: 0, onClose: vi.fn() };
    const { rerender } = render(
      <MemoryRouter><TrackContextMenu {...props} selection={{ tracks: many }} /></MemoryRouter>,
    );
    await act(async () => {});
    await act(async () => { fireEvent.click(item("Mine")!); });
    expect(screen.getByRole("alert").textContent).toContain("1000 of 1500 were added");

    // The same menu, now for three other tracks: the add counted 1000 of the
    // first set, which says nothing about these.
    rerender(<MemoryRouter><TrackContextMenu {...props} track={tracks[0]} selection={{ tracks }} /></MemoryRouter>);
    await act(async () => { fireEvent.click(item("Mine")!); });
    expect(mock.add).toHaveBeenLastCalledWith("mine", ["a", "b", "c"]);
  });

  function Rows() {
    const { bind, menu } = useTrackContextMenu();
    return (
      <MemoryRouter>
        <div onContextMenu={bind(many[0], { selection: { tracks: many } })}>Big selection</div>
        <div onContextMenu={bind(tracks[0])}>One track</div>
        <div onContextMenu={bind(tracks[0], { selection: { tracks } })}>Small selection</div>
        {menu}
      </MemoryRouter>
    );
  }
  // A long-press on Android opens a menu with no mousedown first, so the
  // open one doesn't close: the new open replaces it.
  const longPress = async (row: string) => {
    await act(async () => { fireEvent.contextMenu(screen.getByText(row)); });
  };

  it("on a second open while the first is still showing", async () => {
    render(<Rows />);
    await longPress("One track");
    await act(async () => { fireEvent.click(item("Mine")!); });
    expect((item("Mine") as HTMLButtonElement).disabled).toBe(true);

    // The tick was for that one track, not the selection.
    await longPress("Small selection");
    expect(screen.getByRole("menu", { name: "3 tracks" })).toBeTruthy();
    expect((item("Mine") as HTMLButtonElement).disabled).toBe(false);

    // A 1500-track add stops after the first batch; the next selection still
    // gets all of its tracks, and no error.
    failSecondBatch();
    await longPress("Big selection");
    await act(async () => { fireEvent.click(item("Mine")!); });
    expect(screen.getByRole("alert").textContent).toContain("1000 of 1500 were added");
    await longPress("Small selection");
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { fireEvent.click(item("Mine")!); });
    expect(mock.add).toHaveBeenLastCalledWith("mine", ["a", "b", "c"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect((item("Mine") as HTMLButtonElement).disabled).toBe(true);
  });
});

it("closes on Escape without the page's Escape also clearing the selection", async () => {
  const clear = vi.fn();
  function ClearSelectionOnEscape() {
    useKey("esc", clear, { id: "selection:clear", priority: 5 });
    return null;
  }
  const onClose = vi.fn();
  render(
    <KeyBindingsProvider>
      <ClearSelectionOnEscape />
      <MemoryRouter>
        <TrackContextMenu track={tracks[0]} x={0} y={0} onClose={onClose} selection={{ tracks }} />
      </MemoryRouter>
    </KeyBindingsProvider>,
  );
  await act(async () => {});
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});
