import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PlaylistTracksPanel from "../src/pages/playlist/PlaylistTracksPanel";
import type { PlaylistTrackEntry, TrackListItem } from "../src/api";

const mock = vi.hoisted(() => ({ bind: vi.fn(), open: vi.fn() }));
vi.mock("../src/context/Player", () => ({ usePlayer: () => ({ current: null, isPlaying: false }) }));
vi.mock("../src/lib/useTrackContextMenu", async (original) => ({
  ...await original<typeof import("../src/lib/useTrackContextMenu")>(),
  useTrackContextMenu: () => ({ bind: mock.bind, menu: null }),
}));
vi.mock("../src/lib/useWindowedSlice", () => ({ useWindowedSlice: () => ({ start: 0, end: 50, topSpacerPx: 0, bottomSpacerPx: 0 }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const entries: PlaylistTrackEntry[] = ["a", "b", "c"].map((id, position) => ({
  position, track_id: id, title: `Song ${id}`, duration_ms: 1000, added_at: "2026-01-01T00:00:00Z",
  source: id === "a" ? "local" : "tidal",
}));
// The queue's richer rows, which the menu should get rather than the entries.
const queue: TrackListItem[] = entries.map((e) => ({ id: e.track_id, title: e.title, duration_ms: 1000, source: e.source, album_title: "From the queue" }));
const queueById = new Map(queue.map((t) => [t.id, t]));

function renderPanel(onPlay = vi.fn()) {
  render(
    <PlaylistTracksPanel
      tracks={entries} totalCount={entries.length} searchActive={false} searchQuery=""
      queue={queue} queueById={queueById} canEdit showAddedBy={false}
      onRemove={vi.fn()} onPlay={onPlay} onToggleFav={vi.fn()} isFav={() => false}
    />,
  );
}
const row = (id: string) => screen.getByTitle(`Song ${id}`).closest("tr")!;

it("opens the selection menu for a right-click inside a selection, with the queue's tracks and export", () => {
  mock.bind.mockReturnValue(mock.open);
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(row("a"));
  fireEvent.click(row("c"));

  fireEvent.contextMenu(row("c"));
  const [track, opts] = mock.bind.mock.lastCall!;
  expect(track).toBe(queueById.get("c"));
  expect(opts.queue).toBe(queue);
  expect(opts.selection.tracks).toEqual([queueById.get("a"), queueById.get("c")]);
  expect(opts.selection.exportDisabledReason).toBeUndefined();
  expect(typeof opts.selection.onExport).toBe("function");
  expect(mock.open).toHaveBeenCalledTimes(1);

  fireEvent.contextMenu(row("b"));
  expect(mock.bind.mock.lastCall![0]).toBe(queueById.get("b"));
  expect(mock.bind.mock.lastCall![1].selection).toBeUndefined();
});

it("says why a selection of streaming tracks can't be exported", () => {
  mock.bind.mockReturnValue(mock.open);
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(row("b"));
  fireEvent.click(row("c"));
  fireEvent.contextMenu(row("b"));
  expect(mock.bind.mock.lastCall![1].selection).toMatchObject({
    tracks: [queueById.get("b"), queueById.get("c")],
    exportDisabledReason: "Selected streaming tracks cannot be exported as files.",
  });
});

it("lets the click that closes a menu only close it", () => {
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(row("a"));
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  document.body.append(menu);
  fireEvent.mouseDown(row("b"));
  fireEvent.mouseUp(row("b"));
  fireEvent.click(row("b"));
  menu.remove();
  expect(screen.getByText("1 selected")).toBeTruthy();
});

it("plays a row on Enter only when the row itself has focus, not a button inside it", () => {
  const onPlay = vi.fn();
  renderPanel(onPlay);
  const remove = within(row("b")).getByRole("button", { name: "Remove from playlist" });
  // Not prevented, so the button still does its own thing.
  expect(fireEvent.keyDown(remove, { key: "Enter" })).toBe(true);
  expect(onPlay).not.toHaveBeenCalled();

  fireEvent.keyDown(row("b"), { key: "Enter" });
  expect(onPlay).toHaveBeenCalledWith(entries[1]);
});
