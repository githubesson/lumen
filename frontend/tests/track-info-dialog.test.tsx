import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TrackInfoDialog } from "../src/components/TrackInfoDialog";
import type { TrackDetail } from "../src/api";

const mock = vi.hoisted(() => ({ getTrack: vi.fn() }));
vi.mock("../../core/src/api", async (original) => ({
  ...await original<typeof import("../../core/src/api")>(),
  api: { getTrack: mock.getTrack },
}));

const track = (id: string, aliases: TrackDetail["aliases"]): TrackDetail => ({
  id,
  source: "local",
  title: "Sanfran",
  album_title: "Pusto",
  duration_ms: 164000,
  format: "FLAC",
  file_size: 1000,
  artists: [
    { id: "a1", name: "Oki", role: "primary" },
    { id: "a2", name: "Young Igi", role: "featured" },
  ],
  has_cover: false,
  favorited: false,
  file_name: "Sanfran.flac",
  aliases,
  alias_count: aliases?.length,
});

const sanfran = track("t1", [
  { file_name: "Sanfran v1.mp3", title: "Sanfran v1", artist_names: "Oki", album_title: "Pusto" },
  { file_name: "sanfran snippet.m4a", title: "Sanfran (snippet)", album_title: "Others" },
  { file_name: "SANFRAN.mp3", title: "SANFRAN", artist_names: "OKI", album_title: "PUSTO (Deluxe)" },
]);

// jsdom lays nothing out, so every element reports no client rects and the
// dialog's Tab trap would treat all controls as hidden.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {} as DOMRect,
  ] as unknown as DOMRectList);
  mock.getTrack.mockImplementation((id: string) =>
    Promise.resolve(id === "t1" ? sanfran : track(id, [{ file_name: "Other.mp3" }])),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const columns = () =>
  screen.getAllByRole("columnheader").map((th) => th.textContent);
const picker = () => screen.getByRole("combobox", { name: "Versions to compare" });
const option = (name: RegExp) => screen.getByRole("option", { name });
// The list mounts a frame after the trigger opens it.
const openPicker = async () => {
  fireEvent.click(await screen.findByRole("combobox", { name: "Versions to compare" }));
  return screen.findByRole("listbox");
};

it("shows the track beside its fields and compares the shown copy with the first other", async () => {
  render(<TrackInfoDialog open trackId="t1" onClose={() => {}} />);
  await screen.findByText("Versions (4)");
  const summary = document.querySelector<HTMLElement>(".track-info-summary")!;
  expect(within(summary).getByText("Sanfran")).toBeTruthy();
  expect(within(summary).getByText("Oki, Young Igi")).toBeTruthy();
  expect(within(summary).getByText("Pusto")).toBeTruthy();

  expect(columns()).toEqual(["1Sanfran.flacShown", "2Sanfran v1.mp3"]);
  expect(picker().textContent).toBe("Comparing 2 of 4");
  // Matching the shown copy (only the album here) reads as such, not just
  // as a fade.
  expect(screen.getAllByText("(same as shown)")).toHaveLength(1);
});

it("adds and removes columns from the dropdown, keeping at least one", async () => {
  render(<TrackInfoDialog open trackId="t1" onClose={() => {}} />);
  await openPicker();

  fireEvent.click(option(/SANFRAN\.mp3/));
  expect(columns()).toEqual(["1Sanfran.flacShown", "2Sanfran v1.mp3", "4SANFRAN.mp3"]);
  // The list stays open for more picks.
  expect(screen.getByRole("listbox")).toBeTruthy();

  fireEvent.click(option(/^Sanfran\.flac/));
  fireEvent.click(option(/Sanfran v1\.mp3/));
  expect(columns()).toEqual(["4SANFRAN.mp3"]);
  const last = option(/SANFRAN\.mp3/);
  expect(last.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(last);
  expect(columns()).toEqual(["4SANFRAN.mp3"]);
});

it("closes the list on Escape or a click elsewhere without closing the dialog", async () => {
  const onClose = vi.fn();
  render(<TrackInfoDialog open trackId="t1" onClose={onClose} />);
  const list = await openPicker();
  await waitFor(() => expect(document.activeElement).toBe(list));

  fireEvent.keyDown(list, { key: "ArrowDown" });
  fireEvent.keyDown(list, { key: "ArrowDown" });
  fireEvent.keyDown(list, { key: " " });
  expect(columns()).toHaveLength(3);

  fireEvent.keyDown(list, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(onClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(picker());

  fireEvent.click(picker());
  await screen.findByRole("listbox");
  fireEvent.mouseDown(screen.getByText("Credits"));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(onClose).not.toHaveBeenCalled();
});

it("starts each track's comparison afresh", async () => {
  const { rerender } = render(<TrackInfoDialog open trackId="t1" onClose={() => {}} />);
  await openPicker();
  fireEvent.click(option(/SANFRAN\.mp3/));
  expect(columns()).toHaveLength(3);

  rerender(<TrackInfoDialog open trackId="t2" onClose={() => {}} />);
  await screen.findByText("Versions (2)");
  expect(columns()).toEqual(["1Sanfran.flacShown", "2Other.mp3"]);
});
