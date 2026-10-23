import { describe, expect, it, vi } from "vitest";
import type { TrackListItem } from "@music-library/core";
import type { DownloadRecord } from "../lib/downloads/download-store";
import {
  downloadedTracksSnapshot,
  listDownloadedTracks,
} from "../lib/downloads/downloaded-tracks";

// The selector only reads the store; keep its native modules out of the test.
vi.mock("../lib/downloads/download-store", () => ({ downloadStore: {} }));

function track(id: string): TrackListItem {
  return { id, title: id, duration_ms: 1 };
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
    owners: ["playlist:p"],
    track: track(trackId),
    ...extra,
  };
}

describe("listDownloadedTracks", () => {
  it("lists the newest download first, whatever order the index holds", () => {
    const { tracks, unlisted } = listDownloadedTracks([
      record("middle", 2),
      record("old", 1),
      record("new", 3),
    ]);
    expect(tracks.map((t) => t.id)).toEqual(["new", "middle", "old"]);
    expect(unlisted).toBe(0);
  });

  it("counts the downloads with no snapshot to draw a row from", () => {
    const { tracks, unlisted } = listDownloadedTracks([
      record("listed", 2),
      record("legacy", 3, { track: undefined }),
    ]);
    expect(tracks.map((t) => t.id)).toEqual(["listed"]);
    expect(unlisted).toBe(1);
  });

  it("is empty with no downloads", () => {
    expect(listDownloadedTracks([])).toEqual({ tracks: [], unlisted: 0 });
  });
});

describe("downloadedTracksSnapshot", () => {
  function fakeStore(records: DownloadRecord[]) {
    const store = {
      version: 0,
      records,
      getVersion: () => store.version,
      listRecords: vi.fn(() => [...store.records]),
    };
    return store;
  }

  it("returns the same list until the store changes", () => {
    const store = fakeStore([record("a", 1)]);
    const first = downloadedTracksSnapshot(store);
    expect(downloadedTracksSnapshot(store)).toBe(first);
    expect(store.listRecords).toHaveBeenCalledOnce();
  });

  it("recomputes when a download lands", () => {
    const store = fakeStore([record("a", 1)]);
    const before = downloadedTracksSnapshot(store);
    store.records = [...store.records, record("b", 2)];
    store.version += 1;
    const after = downloadedTracksSnapshot(store);
    expect(after).not.toBe(before);
    expect(after.tracks.map((t) => t.id)).toEqual(["b", "a"]);
  });
});
