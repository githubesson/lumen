import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import TrackContextMenu from "../src/components/TrackContextMenu";
import { PlaylistsProvider, usePlaylists } from "../src/context/Playlists";
import type { Playlist } from "../src/api";

const mock = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn() }));
vi.mock("../../core/src/api", async (original) => ({
  ...await original<typeof import("../../core/src/api")>(),
  api: { listPlaylists: mock.list, addPlaylistTracks: mock.add },
}));
vi.mock("../src/context/Auth", () => ({ useAuth: () => ({ me: { id: "user", role: "user", must_reset_password: false } }) }));
vi.mock("../src/context/Player", () => ({ usePlayer: () => ({ play: vi.fn() }) }));
vi.mock("../src/context/Favorites", () => ({ useFavorites: () => ({ isFavorite: () => false, toggle: vi.fn() }) }));

const playlist: Playlist = {
  id: "playlist", owner_id: "user", name: "Editable", visibility: "private",
  is_smart: false, effective_role: "owner", created_at: "", updated_at: "",
};

function Harness() {
  const { data } = usePlaylists();
  const [open, setOpen] = useState(false);
  return (
    <>
      <aside>{data?.map((p) => <span key={p.id}>{p.name}</span>)}</aside>
      <button onClick={() => setOpen((value) => !value)}>Toggle menu</button>
      {open && <TrackContextMenu track={{ id: "track", title: "Song", duration_ms: 1000 }} x={0} y={0} onClose={() => setOpen(false)} />}
    </>
  );
}
function renderMenu() {
  return render(<MemoryRouter><PlaylistsProvider><Harness /></PlaylistsProvider></MemoryRouter>);
}
beforeEach(() => { vi.clearAllMocks(); mock.list.mockResolvedValue([playlist]); mock.add.mockResolvedValue(undefined); });
afterEach(cleanup);

it("shares the pending shell request across repeated menu openings", async () => {
  let resolve!: (rows: Playlist[]) => void;
  mock.list.mockReturnValue(new Promise<Playlist[]>((done) => { resolve = done; }));
  renderMenu();
  fireEvent.click(screen.getByText("Toggle menu"));
  expect(screen.getByText("Loading…")).toBeTruthy();
  expect(mock.list).toHaveBeenCalledTimes(1);
  await act(async () => { resolve([playlist]); });
  expect(screen.getByRole("menuitem", { name: "Editable" })).toBeTruthy();
  fireEvent.click(screen.getByText("Toggle menu"));
  fireEvent.click(screen.getByText("Toggle menu"));
  expect(screen.getByRole("menuitem", { name: "Editable" })).toBeTruthy();
  expect(mock.list).toHaveBeenCalledTimes(1);
});

it("keeps click targets in place across several adds and refreshes once on close", async () => {
  const rows = ["Alpha", "Bravo", "Charlie"].map((name) => ({ ...playlist, id: name, name }));
  mock.list.mockResolvedValueOnce(rows).mockResolvedValue([rows[2], rows[1], rows[0]]);
  renderMenu();
  await act(async () => {});
  fireEvent.click(screen.getByText("Toggle menu"));
  const order = () => screen.getAllByRole("menuitem")
    .map((element) => element.textContent)
    .filter((name) => rows.some((row) => row.name === name));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Charlie" })); });
  expect(order()).toEqual(["Alpha", "Bravo", "Charlie"]);
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Bravo" })); });
  expect(order()).toEqual(["Alpha", "Bravo", "Charlie"]);
  expect(mock.add.mock.calls).toEqual([["Charlie", ["track"]], ["Bravo", ["track"]]]);
  expect(mock.list).toHaveBeenCalledTimes(1);

  await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(mock.list).toHaveBeenCalledTimes(2);
  expect([...document.querySelectorAll("aside span")].map((element) => element.textContent))
    .toEqual(["Charlie", "Bravo", "Alpha"]);
});

it("does not refresh on close if no add succeeded", async () => {
  mock.add.mockRejectedValueOnce(new Error("Failed"));
  renderMenu();
  await act(async () => {});
  fireEvent.click(screen.getByText("Toggle menu"));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Editable" })); });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(mock.list).toHaveBeenCalledTimes(1);
});

it("refreshes when an in-flight add succeeds after the menu closes", async () => {
  let resolve!: () => void;
  mock.add.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
  renderMenu();
  await act(async () => {});
  fireEvent.click(screen.getByText("Toggle menu"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Editable" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(mock.list).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(); });
  expect(mock.list).toHaveBeenCalledTimes(2);
});

it("lets the menu retry a failed shared request", async () => {
  mock.list.mockRejectedValueOnce(new Error("Offline"));
  renderMenu();
  await act(async () => {});
  fireEvent.click(screen.getByText("Toggle menu"));
  expect(screen.getByRole("alert").textContent).toBe("Could not load playlists.");
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Retry playlists" })); });
  expect(screen.getByRole("menuitem", { name: "Editable" })).toBeTruthy();
  expect(mock.list).toHaveBeenCalledTimes(2);
});
