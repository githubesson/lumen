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
vi.mock("../src/context/Player", () => ({ usePlayer: () => ({ play: vi.fn() }), usePlayerControls: () => ({ play: vi.fn() }) }));
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

it("revalidates the shared list on open and holds adds until the fresh list lands", async () => {
  let resolve!: (rows: Playlist[]) => void;
  mock.list
    .mockResolvedValueOnce([playlist])
    .mockReturnValueOnce(new Promise<Playlist[]>((done) => { resolve = done; }));
  renderMenu();
  await act(async () => {});
  fireEvent.click(screen.getByText("Toggle menu"));
  expect(mock.list).toHaveBeenCalledTimes(2);
  const stale = screen.getByRole("menuitem", { name: "Editable" }) as HTMLButtonElement;
  expect(stale.disabled).toBe(true);
  await act(async () => { resolve([{ ...playlist, name: "Renamed elsewhere" }]); });
  const fresh = screen.getByRole("menuitem", { name: "Renamed elsewhere" }) as HTMLButtonElement;
  expect(fresh.disabled).toBe(false);
});

it("keeps click targets in place across several adds and refreshes once on close", async () => {
  const rows = ["Alpha", "Bravo", "Charlie"].map((name) => ({ ...playlist, id: name, name }));
  mock.list.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows).mockResolvedValue([rows[2], rows[1], rows[0]]);
  renderMenu();
  await act(async () => {});
  fireEvent.click(screen.getByText("Toggle menu"));
  await act(async () => {});
  const order = () => screen.getAllByRole("menuitem")
    .map((element) => element.textContent)
    .filter((name) => rows.some((row) => row.name === name));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Charlie" })); });
  expect(order()).toEqual(["Alpha", "Bravo", "Charlie"]);
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Bravo" })); });
  expect(order()).toEqual(["Alpha", "Bravo", "Charlie"]);
  expect(mock.add.mock.calls).toEqual([["Charlie", ["track"]], ["Bravo", ["track"]]]);
  expect(mock.list).toHaveBeenCalledTimes(2);

  await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(mock.list).toHaveBeenCalledTimes(3);
  expect([...document.querySelectorAll("aside span")].map((element) => element.textContent))
    .toEqual(["Charlie", "Bravo", "Alpha"]);
});

it("does not refresh on close if no add succeeded", async () => {
  mock.add.mockRejectedValueOnce(new Error("Failed"));
  renderMenu();
  await act(async () => {});
  fireEvent.click(screen.getByText("Toggle menu"));
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Editable" })); });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(mock.list).toHaveBeenCalledTimes(2);
});

it("refreshes when an in-flight add succeeds after the menu closes", async () => {
  let resolve!: () => void;
  mock.add.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
  renderMenu();
  await act(async () => {});
  fireEvent.click(screen.getByText("Toggle menu"));
  await act(async () => {});
  fireEvent.click(screen.getByRole("menuitem", { name: "Editable" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(mock.list).toHaveBeenCalledTimes(2);
  await act(async () => { resolve(); });
  expect(mock.list).toHaveBeenCalledTimes(3);
});

it("lets the menu retry a failed shared request", async () => {
  mock.list.mockRejectedValueOnce(new Error("Offline")).mockRejectedValueOnce(new Error("Offline"));
  renderMenu();
  await act(async () => {});
  fireEvent.click(screen.getByText("Toggle menu"));
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toBe("Could not load playlists.");
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Retry playlists" })); });
  expect(screen.getByRole("menuitem", { name: "Editable" })).toBeTruthy();
  expect(mock.list).toHaveBeenCalledTimes(3);
});

it("keeps stale rows disabled after a failed refresh until a retry succeeds", async () => {
  mock.list.mockResolvedValueOnce([playlist]).mockRejectedValueOnce(new Error("Offline"));
  renderMenu();
  await act(async () => {});
  fireEvent.click(screen.getByText("Toggle menu"));
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toBe("Could not load playlists.");
  expect((screen.getByRole("menuitem", { name: "Editable" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Retry playlists" })); });
  expect((screen.getByRole("menuitem", { name: "Editable" }) as HTMLButtonElement).disabled).toBe(false);
});
