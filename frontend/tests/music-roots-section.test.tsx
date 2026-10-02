import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type MusicRoot, type RescanStatus } from "../src/api";
import { libraryChanged } from "../src/lib/events";
import { clearResourceCache } from "../src/lib/resourceCache";
import { MusicRootsSection } from "../src/pages/admin/MusicRootsSection";

const primary: MusicRoot = {
  id: "",
  path: "/music",
  label: "Primary (MUSIC_PATH)",
  enabled: true,
  primary: true,
  exists: true,
};
const inner: MusicRoot = {
  id: "8d3c2a52-6c43-4c43-9d55-8d5b0f1f7e10",
  path: "/music/flac",
  label: "",
  enabled: true,
  primary: false,
  exists: true,
  covered_by: "/music",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

let changed: ReturnType<typeof vi.fn<() => void>>;
let stopListening: () => void;

beforeEach(() => {
  vi.spyOn(api, "musicRootUsage").mockResolvedValue({ roots: [], measured_at: "" });
  vi.spyOn(api, "listIngestErrors").mockResolvedValue({ errors: [], total: 0 });
  vi.spyOn(api, "rescanStatus").mockResolvedValue({ running: false });
  vi.spyOn(api, "startRescan").mockResolvedValue(undefined);
  vi.spyOn(api, "deleteMusicRoot").mockResolvedValue({ deleted_tracks: 0 });
  changed = vi.fn<() => void>();
  stopListening = libraryChanged.on(changed);
});
afterEach(() => {
  stopListening();
  cleanup();
  clearResourceCache();
  vi.restoreAllMocks();
});

function renderSection(roots: MusicRoot[] = [primary, inner]) {
  return render(
    <MusicRootsSection roots={roots} reloadRoots={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />,
  );
}

it("leaves the library alone for the last scan's counts on load", async () => {
  vi.mocked(api.rescanStatus).mockResolvedValue({ running: false, processed: 500 });
  renderSection();
  await screen.findByText("Last scan");
  expect(changed).not.toHaveBeenCalled();
});

/** Starts a rescan whose first status read reports it already finished. */
async function rescanFinishingWith(status: RescanStatus) {
  await waitFor(() => expect(api.rescanStatus).toHaveBeenCalled());
  const read = deferred<RescanStatus>();
  vi.mocked(api.rescanStatus).mockReturnValue(read.promise);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Rescan all folders" }));
  });
  expect(screen.getByRole("button", { name: /^Scanning/ })).toBeTruthy();
  await act(async () => { read.resolve(status); });
}

it("refreshes the library once after a scan it saw finish with work done", async () => {
  renderSection();
  await rescanFinishingWith({ running: false, processed: 3 });
  expect(changed).toHaveBeenCalledOnce();
});

it("refreshes the library after a scan that only pruned files", async () => {
  renderSection();
  await rescanFinishingWith({ running: false, processed: 0, pruned: 4 });
  expect(changed).toHaveBeenCalledOnce();
});

it("leaves the library alone after a scan that found nothing", async () => {
  renderSection();
  await rescanFinishingWith({ running: false, processed: 0, pruned: 0 });
  // The finish was still seen: the folder sizes are measured again.
  await waitFor(() => expect(api.musicRootUsage).toHaveBeenCalledTimes(2));
  expect(changed).not.toHaveBeenCalled();
});

it("offers no actions on the primary root and no purge for a covered one", async () => {
  renderSection();
  expect(screen.getByText("Primary")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove /music" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Pause /music" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Remove /music/flac" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Remove flac?")).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "Remove tracks" })).toBeNull();
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove folder" }));
  });
  expect(api.deleteMusicRoot).toHaveBeenCalledWith(inner.id, { purge: false });
  expect(changed).not.toHaveBeenCalled();
});
