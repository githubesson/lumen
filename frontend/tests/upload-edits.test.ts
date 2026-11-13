import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  updateTrack: vi.fn(),
  getTrack: vi.fn(),
  setTrackCover: vi.fn(),
  setAlbumCover: vi.fn(),
}));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: mock,
}));
import { applyUploadEdits, emptyUploadEdits, uploadPatch } from "../src/lib/uploadEdits";
import { ApiError } from "../../core/src/api-transport";

beforeEach(() => {
  vi.clearAllMocks();
  mock.updateTrack.mockImplementation(async (id: string) => ({ id, album_id: "al-1" }));
  mock.getTrack.mockImplementation(async (id: string) => ({ id, album_id: "al-1" }));
});

it("sends only what was typed; blank keeps the file's tags", () => {
  const edits = emptyUploadEdits(2);
  expect(uploadPatch(edits, 0)).toBeNull();
  edits.perFile[1] = { title: " lol ", artists: "Baby Smoove, Guest" };
  edits.album = "Webcore Friends";
  expect(uploadPatch(edits, 1)).toEqual({ title: "lol", artists: ["Baby Smoove", "Guest"], album_title: "Webcore Friends" });
  expect(uploadPatch(edits, 0)).toEqual({ album_title: "Webcore Friends" });
});

it("changes only new tracks, and puts the cover on each album once", async () => {
  const edits = { ...emptyUploadEdits(3), album: "A", cover: new File(["x"], "c.png") };
  const out = await applyUploadEdits(
    [
      { file: "1.flac", inserted: true, track_id: "t1" },
      { file: "2.flac", inserted: false, dedup: true, track_id: "existing" },
      { file: "3.flac", inserted: true, track_id: "t3" },
    ],
    [0, 1, 2],
    edits,
    "personal",
  );
  expect(mock.updateTrack.mock.calls.map(([id]) => id)).toEqual(["t1", "t3"]);
  expect(mock.setTrackCover).toHaveBeenCalledTimes(1);
  expect(mock.setAlbumCover).not.toHaveBeenCalled();
  expect(out.every((r) => !r.error)).toBe(true);
});

it("sets the shared album's cover for a global upload, and reports a failed save on its file", async () => {
  mock.updateTrack.mockRejectedValueOnce(new Error("nope"));
  const edits = { ...emptyUploadEdits(2), album: "A", cover: new File(["x"], "c.png") };
  const out = await applyUploadEdits(
    [{ file: "1.flac", inserted: true, track_id: "t1" }, { file: "2.flac", inserted: true, track_id: "t2" }],
    [0, 1],
    edits,
    "global",
  );
  expect(out[0].error).toMatch(/Added, but saving the details failed/);
  expect(mock.setAlbumCover).toHaveBeenCalledWith("al-1", edits.cover, expect.anything());
});

it("covers an album once across batches, and waits out a rate-limited cover", async () => {
  vi.useFakeTimers();
  try {
    mock.setTrackCover.mockRejectedValueOnce(new ApiError(429, "rate limit exceeded", 2)).mockResolvedValue({});
    const edits = { ...emptyUploadEdits(2), cover: new File(["x"], "c.png") };
    const coveredAlbums = new Set<string>();
    const first = applyUploadEdits([{ file: "1.flac", inserted: true, track_id: "t1" }], [0], edits, "personal", { coveredAlbums });
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await first)[0].error).toBeUndefined();
    expect(mock.setTrackCover).toHaveBeenCalledTimes(2);
    // The next batch's track is on the same album: no second cover.
    await applyUploadEdits([{ file: "2.flac", inserted: true, track_id: "t2" }], [1], edits, "personal", { coveredAlbums });
    expect(mock.setTrackCover).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("stops at a cancel instead of reporting the aborted save as a failure", async () => {
  const ctrl = new AbortController();
  mock.updateTrack.mockImplementationOnce(async () => {
    ctrl.abort();
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });
  const edits = { ...emptyUploadEdits(2), album: "A" };
  await expect(
    applyUploadEdits(
      [{ file: "1.flac", inserted: true, track_id: "t1" }, { file: "2.flac", inserted: true, track_id: "t2" }],
      [0, 1],
      edits,
      "personal",
      { signal: ctrl.signal },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mock.updateTrack).toHaveBeenCalledTimes(1);
  expect(mock.updateTrack).toHaveBeenCalledWith("t1", { album_title: "A" }, { signal: ctrl.signal });
});
