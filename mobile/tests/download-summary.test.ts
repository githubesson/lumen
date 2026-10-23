import { describe, expect, it, vi } from "vitest";
import type { TrackListItem } from "@music-library/core";
import type { DownloadRecord } from "../lib/downloads/download-store";
import {
  downloadSummarySnapshot,
  summarizeDownloads,
} from "../lib/downloads/download-summary";

// The selector only reads the store; keep its native modules out of the test.
vi.mock("../lib/downloads/download-store", () => ({ downloadStore: {} }));

function track(id: string, albumId?: string, extra: Partial<TrackListItem> = {}): TrackListItem {
  return { id, title: id, album_id: albumId, duration_ms: 1, ...extra };
}

function record(
  trackId: string,
  downloadedAt: number,
  extra: Partial<DownloadRecord> = {},
): DownloadRecord {
  return {
    trackId,
    filename: `${trackId}.mp3`,
    size: 1_000,
    downloadedAt,
    owners: ["track"],
    ...extra,
  };
}

describe("summarizeDownloads", () => {
  it("counts the songs and adds up their bytes", () => {
    const summary = summarizeDownloads(
      [
        record("a", 1, { size: 4_000_000 }),
        record("b", 2, { size: 6_500_000 }),
        // A size the index lost reads as nothing, not NaN.
        record("c", 3, { size: Number.NaN }),
      ],
      { ready: true },
    );
    expect(summary).toMatchObject({ ready: true, count: 3, bytes: 10_500_000 });
  });

  it("is empty, and says whether the store has loaded, with no downloads", () => {
    expect(summarizeDownloads([], { ready: false })).toEqual({
      ready: false,
      count: 0,
      bytes: 0,
      recent: [],
    });
  });

  it("shows the newest covers first, one per album", () => {
    const summary = summarizeDownloads(
      [
        record("old", 1, { coverFilename: "cover_x.jpg", track: track("old", "x") }),
        record("new", 5, { coverFilename: "cover_y.jpg", track: track("new", "y") }),
        // Same album as "new": its cover is already in the stack.
        record("sibling", 4, { coverFilename: "cover_y.jpg", track: track("sibling", "y") }),
        record("mid", 3, { coverFilename: "cover_z.jpg", track: track("mid", "z") }),
      ],
      { ready: true },
    );
    expect(summary.recent.map((cover) => cover.trackId)).toEqual(["new", "mid", "old"]);
    expect(summary.recent[0].track?.album_id).toBe("y");
  });

  it("keeps to the limit, preferring covers stored on the device", () => {
    const summary = summarizeDownloads(
      [
        record("remote-newest", 10, { track: track("remote-newest", "r1") }),
        record("s1", 9, { coverFilename: "cover_1.jpg" }),
        record("s2", 8, { coverFilename: "cover_2.jpg" }),
        record("s3", 7, { coverFilename: "cover_3.jpg" }),
        record("s4", 6, { coverFilename: "cover_4.jpg" }),
        record("s5", 5, { coverFilename: "cover_5.jpg" }),
      ],
      { ready: true },
    );
    expect(summary.recent.map((cover) => cover.trackId)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("fills spare slots with songs whose cover isn't stored, but not ones with no cover", () => {
    const summary = summarizeDownloads(
      [
        record("stored", 1, { coverFilename: "cover_a.jpg" }),
        record("remote", 3, { track: track("remote", "b") }),
        record("bare", 4, { track: track("bare", "c", { has_cover: false }) }),
        // An old record with neither a cover file nor a snapshot.
        record("legacy", 2),
      ],
      { ready: true, coverLimit: 4 },
    );
    expect(summary.recent.map((cover) => cover.trackId)).toEqual(["remote", "legacy", "stored"]);
  });
  it("gives an album one slot, whichever of its songs has the cover file", () => {
    const summary = summarizeDownloads(
      [
        // The album's newest song has no stored cover; an older one does.
        record("newer", 5, { track: track("newer", "al") }),
        record("older", 2, { coverFilename: "cover_al.jpg", track: track("older", "al") }),
        record("other", 3, { coverFilename: "cover_o.jpg", track: track("other", "o") }),
      ],
      { ready: true },
    );
    // Shown with the stored cover, but placed by the album's latest download.
    expect(summary.recent.map((cover) => cover.trackId)).toEqual(["older", "other"]);
  });

  it("finds the album of a record older than the track snapshot by its cover file", () => {
    const summary = summarizeDownloads(
      [
        record("legacy", 4, { coverFilename: "cover_al.jpg" }),
        record("known", 3, { coverFilename: "cover_al.jpg", track: track("known", "al") }),
        record("unstored", 2, { track: track("unstored", "al") }),
      ],
      { ready: true },
    );
    expect(summary.recent.map((cover) => cover.trackId)).toEqual(["legacy"]);
  });
});

describe("downloadSummarySnapshot", () => {
  function fakeStore(records: DownloadRecord[]) {
    const store = {
      version: 0,
      records,
      ready: false,
      getVersion: () => store.version,
      listRecords: vi.fn(() => [...store.records]),
    };
    return store;
  }

  it("returns the same summary until the store changes", () => {
    const store = fakeStore([record("a", 1)]);
    const first = downloadSummarySnapshot(store);
    expect(downloadSummarySnapshot(store)).toBe(first);
    expect(store.listRecords).toHaveBeenCalledOnce();
  });

  it("recomputes when a download lands or the store finishes loading", () => {
    const store = fakeStore([record("a", 1, { size: 10 })]);
    const before = downloadSummarySnapshot(store);
    expect(before).toMatchObject({ ready: false, count: 1, bytes: 10 });

    store.records = [...store.records, record("b", 2, { size: 5 })];
    store.ready = true;
    store.version += 1;
    const after = downloadSummarySnapshot(store);
    expect(after).not.toBe(before);
    expect(after).toMatchObject({ ready: true, count: 2, bytes: 15 });
  });

  it("keeps each store's summary apart (the store is swapped on account change)", () => {
    const first = fakeStore([record("a", 1)]);
    const second = fakeStore([]);
    expect(downloadSummarySnapshot(first).count).toBe(1);
    expect(downloadSummarySnapshot(second).count).toBe(0);
  });
});
