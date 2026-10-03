import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TrackInfoDialog } from "../src/components/TrackInfoDialog";
import { ApiError, type TidalTrackInfo, type TrackDetail } from "../src/api";

const mock = vi.hoisted(() => ({ getTrack: vi.fn(), getTidalTrack: vi.fn() }));
vi.mock("../../core/src/api", async (original) => ({
  ...await original<typeof import("../../core/src/api")>(),
  api: { getTrack: mock.getTrack, getTidalTrack: mock.getTidalTrack },
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
  mock.getTidalTrack.mockReset();
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
const picker = () => screen.getByRole("combobox", { name: /^Versions to compare/ });
// jsdom drops the space after "Version n:" that browsers keep in the name.
const option = (name: RegExp) => screen.getByRole("option", { name });
// The list mounts a frame after the trigger opens it.
const openPicker = async () => {
  fireEvent.click(await screen.findByRole("combobox", { name: /^Versions to compare/ }));
  return screen.findByRole("listbox");
};

it("shows the track beside its fields and compares the shown copy with the first other", async () => {
  render(<TrackInfoDialog open trackId="t1" onClose={() => {}} />);
  await screen.findByText("Versions (4)");
  const summary = document.querySelector<HTMLElement>(".track-info-summary")!;
  expect(within(summary).getByText("Sanfran")).toBeTruthy();
  expect(within(summary).getByText("Oki, Young Igi")).toBeTruthy();
  expect(within(summary).getByText("Pusto")).toBeTruthy();

  expect(columns()).toEqual(["1Version 1: Sanfran.flacShown", "2Version 2: Sanfran v1.mp3"]);
  expect(picker().textContent).toBe("Comparing 2 of 4");
  expect(picker().getAttribute("aria-label")).toBe("Versions to compare: Comparing 2 of 4");
  // Matching the shown copy (only the album here) reads as such, not just
  // as a fade.
  expect(screen.getAllByText("(same as shown)")).toHaveLength(1);
});

it("adds and removes columns from the dropdown, keeping at least one", async () => {
  render(<TrackInfoDialog open trackId="t1" onClose={() => {}} />);
  await openPicker();

  fireEvent.click(option(/SANFRAN\.mp3/));
  expect(columns()).toEqual(["1Version 1: Sanfran.flacShown", "2Version 2: Sanfran v1.mp3", "4Version 4: SANFRAN.mp3"]);
  // The list stays open for more picks.
  expect(screen.getByRole("listbox")).toBeTruthy();

  fireEvent.click(option(/^Version 1:\s*Sanfran\.flac/));
  fireEvent.click(option(/Sanfran v1\.mp3/));
  expect(columns()).toEqual(["4Version 4: SANFRAN.mp3"]);
  const last = option(/SANFRAN\.mp3/);
  expect(last.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(last);
  expect(columns()).toEqual(["4Version 4: SANFRAN.mp3"]);
});

it("closes the list on Escape or a click elsewhere without closing the dialog", async () => {
  const onClose = vi.fn();
  render(<TrackInfoDialog open trackId="t1" onClose={onClose} />);
  const list = await openPicker();
  await waitFor(() => expect(document.activeElement).toBe(list));
  expect(screen.getByRole("listbox", { name: "Versions to compare" })).toBe(list);

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
  // Focus stays in the dialog rather than leaving with the list.
  expect(document.activeElement).toBe(picker());
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(onClose).not.toHaveBeenCalled();
});

it("wraps Tab from the open list round the dialog instead of out of it", async () => {
  render(<TrackInfoDialog open trackId="t1" onClose={() => {}} />);
  const list = await openPicker();
  await waitFor(() => expect(document.activeElement).toBe(list));

  // The picker is the dialog's last control.
  fireEvent.keyDown(list, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
});

it("takes focus back when reopened while fading out", async () => {
  render(<TrackInfoDialog open trackId="t1" onClose={() => {}} />);
  const list = await openPicker();
  await waitFor(() => expect(document.activeElement).toBe(list));

  // A press on the trigger focuses it, then the click closes the list.
  picker().focus();
  fireEvent.click(picker());
  // Still mounted for its exit fade when the trigger opens it again.
  fireEvent.click(picker());
  await waitFor(() => expect(document.activeElement).toBe(list));
  expect(screen.getByRole("listbox")).toBe(list);
});

it("names each version by its number, so identical copies stay distinct", async () => {
  mock.getTrack.mockResolvedValueOnce(
    track("t3", [{ file_name: "Twin.mp3" }, { file_name: "Twin.mp3" }]),
  );
  render(<TrackInfoDialog open trackId="t3" onClose={() => {}} />);
  await openPicker();
  expect(screen.getByRole("option", { name: /^Version 2:\s*Twin\.mp3/ })).toBeTruthy();
  expect(screen.getByRole("option", { name: /^Version 3:\s*Twin\.mp3/ })).toBeTruthy();
});

it("starts each track's comparison afresh", async () => {
  const { rerender } = render(<TrackInfoDialog open trackId="t1" onClose={() => {}} />);
  await openPicker();
  fireEvent.click(option(/SANFRAN\.mp3/));
  expect(columns()).toHaveLength(3);

  rerender(<TrackInfoDialog open trackId="t2" onClose={() => {}} />);
  await screen.findByText("Versions (2)");
  expect(columns()).toEqual(["1Version 1: Sanfran.flacShown", "2Version 2: Other.mp3"]);
});

// A TIDAL track's row, as the server materializes it from a stream.
const tidalRow: TrackDetail = {
  id: "tidal:500",
  db_track_id: "r1",
  source: "tidal",
  source_id: "500",
  title: "Forever $cams",
  album_title: "Bin Reaper 3: New Testament",
  track_no: 1,
  disc_no: 1,
  duration_ms: 228000,
  format: "tidal",
  file_size: 0,
  artists: [{ id: "a1", name: "BabyTron", role: "primary" }],
  has_cover: false,
  favorited: false,
};

const tidalInfo: TidalTrackInfo = {
  id: "500",
  artists: [{ name: "BabyTron", role: "main" }],
  release_date: "2023-03-17",
  copyright: "(P) 2023 The Hip Hop Lab",
  isrc: "QZES72300001",
  bpm: 140,
  key: "F♯ minor",
  streamed_quality: "LOSSLESS",
  max_quality: "HI_RES_LOSSLESS",
  channels: 2,
  credits: [
    { role: "Producer", names: ["Helluva"] },
    { role: "Mixing Engineer", names: ["Mixer"] },
  ],
};

const field = (label: string) =>
  screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

it("fills a TIDAL track's fields from TIDAL", async () => {
  mock.getTrack.mockResolvedValueOnce(tidalRow);
  mock.getTidalTrack.mockResolvedValueOnce(tidalInfo);
  render(<TrackInfoDialog open trackId="tidal:500" onClose={() => {}} />);
  await screen.findByText("Released");
  expect(mock.getTidalTrack).toHaveBeenCalledWith("500", expect.anything());

  expect(field("Producers")).toBe("Helluva");
  expect(field("Mixing engineer")).toBe("Mixer");
  expect(field("Released")).toBe(
    new Date(Date.UTC(2023, 2, 17)).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }),
  );
  expect(field("BPM")).toBe("140");
  expect(field("Key")).toBe("F♯ minor");
  expect(field("ISRC")).toBe("QZES72300001");
  expect(field("Copyright")).toBe("(P) 2023 The Hip Hop Lab");
  expect(field("Source")).toBe("TIDAL");
  expect(field("Format")).toBe("FLAC");
  expect(field("Quality")).toBe("Lossless");
  expect(field("Sample rate")).toBe("44.1 kHz");
  expect(field("Channels")).toBe("2");
  // A stream has no file, and TIDAL no genres.
  expect(screen.queryByText("File size")).toBeNull();
  expect(screen.queryByText("Genre")).toBeNull();
  expect(screen.queryByText("Year")).toBeNull();
});

it("shows only the most it would stream before the server has streamed it", async () => {
  mock.getTrack.mockResolvedValueOnce(tidalRow);
  mock.getTidalTrack.mockResolvedValueOnce({ ...tidalInfo, streamed_quality: undefined });
  render(<TrackInfoDialog open trackId="tidal:500" onClose={() => {}} />);
  await screen.findByText("Released");
  expect(field("Quality")).toBe("Up to Hi-Res Lossless (24-bit FLAC)");
  expect(screen.queryByText("Format")).toBeNull();
  expect(screen.queryByText("Bit depth")).toBeNull();
});

it("waits for TIDAL before showing a TIDAL track's fields", async () => {
  mock.getTrack.mockResolvedValueOnce(tidalRow);
  let answer!: (info: TidalTrackInfo) => void;
  mock.getTidalTrack.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
  render(<TrackInfoDialog open trackId="tidal:500" onClose={() => {}} />);
  await waitFor(() => expect(mock.getTidalTrack).toHaveBeenCalled());
  expect(screen.getByText("Loading…")).toBeTruthy();
  expect(screen.queryByText("Credits")).toBeNull();
  answer(tidalInfo);
  await screen.findByText("Released");
});

it("shows the stored fields when TIDAL can't answer", async () => {
  mock.getTrack.mockResolvedValueOnce({ ...tidalRow, year: 2023 });
  mock.getTidalTrack.mockRejectedValueOnce(new Error("tidal track unavailable"));
  render(<TrackInfoDialog open trackId="tidal:500" onClose={() => {}} />);
  await screen.findByText(/Couldn't load more from TIDAL/);
  expect(field("Primary artist")).toBe("BabyTron");
  expect(field("Year")).toBe("2023");
  expect(field("Source")).toBe("TIDAL");
  expect(field("Quality")).toBe("—");
  expect(field("Duration")).toBe("3:48");
});

it("says why TIDAL refused the track", async () => {
  mock.getTrack.mockResolvedValueOnce(tidalRow);
  const reason = "TIDAL refused this track: Not available in your region";
  mock.getTidalTrack.mockRejectedValueOnce(new ApiError(502, reason));
  render(<TrackInfoDialog open trackId="tidal:500" onClose={() => {}} />);
  await screen.findByText(reason);
  expect(screen.queryByText(/Couldn't load more from TIDAL/)).toBeNull();
  expect(field("Primary artist")).toBe("BabyTron");
});

it("keeps the generic note for a failure that isn't a refusal", async () => {
  mock.getTrack.mockResolvedValueOnce(tidalRow);
  mock.getTidalTrack.mockRejectedValueOnce(new ApiError(502, "tidal track unavailable"));
  render(<TrackInfoDialog open trackId="tidal:500" onClose={() => {}} />);
  await screen.findByText(/Couldn't load more from TIDAL/);
  expect(screen.queryByText("tidal track unavailable")).toBeNull();
});

it("says when only TIDAL's credits are missing", async () => {
  mock.getTrack.mockResolvedValueOnce(tidalRow);
  mock.getTidalTrack.mockResolvedValueOnce({ ...tidalInfo, credits: [], credits_failed: true });
  render(<TrackInfoDialog open trackId="tidal:500" onClose={() => {}} />);
  await screen.findByText("Couldn't load credits from TIDAL.");
  expect(field("Producers")).toBe("—");
  expect(screen.queryByText(/Couldn't load more/)).toBeNull();
});

it("says why TIDAL refused the credits", async () => {
  mock.getTrack.mockResolvedValueOnce(tidalRow);
  const reason = "TIDAL refused the credits: Not available in your region";
  mock.getTidalTrack.mockResolvedValueOnce({ ...tidalInfo, credits: [], credits_failed: true, credits_failure: reason });
  render(<TrackInfoDialog open trackId="tidal:500" onClose={() => {}} />);
  await screen.findByText(reason);
  expect(screen.queryByText("Couldn't load credits from TIDAL.")).toBeNull();
});

it("says why TIDAL refused the album's release date", async () => {
  mock.getTrack.mockResolvedValueOnce(tidalRow);
  const reason = "TIDAL refused the album's release date: Not available in your region";
  mock.getTidalTrack.mockResolvedValueOnce({ ...tidalInfo, release_failure: reason });
  render(<TrackInfoDialog open trackId="tidal:500" onClose={() => {}} />);
  await screen.findByText(reason);
});

it("never asks TIDAL about a local track", async () => {
  render(<TrackInfoDialog open trackId="t1" onClose={() => {}} />);
  await screen.findByText("Versions (4)");
  expect(mock.getTidalTrack).not.toHaveBeenCalled();
  expect(field("Format")).toBe("FLAC");
  expect(screen.queryByText("Source")).toBeNull();
});
