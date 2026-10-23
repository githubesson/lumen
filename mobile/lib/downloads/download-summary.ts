import { useSyncExternalStore } from "react";
import type { TrackListItem } from "@music-library/core";
import {
  downloadStore,
  type DownloadRecord,
  type DownloadStore,
} from "./download-store";

/** What Settings shows about the music kept on this device. */
export interface DownloadSummary {
  /** False until the store has read its index; the figures read 0 until then. */
  ready: boolean;
  /** Downloaded songs. */
  count: number;
  /** Bytes of downloaded audio. Covers are left out: one file serves a whole
   *  album, and they're small next to the audio. */
  bytes: number;
  /** Recently downloaded songs with distinct artwork, newest first. */
  recent: DownloadedCover[];
}

export interface DownloadedCover {
  trackId: string;
  /** The record's track snapshot; records older than that field have none. */
  track?: TrackListItem;
}

/** How many covers the Settings downloads stack fans out. */
export const RECENT_COVER_LIMIT = 4;

/**
 * Count, size and a few recent covers of the stored downloads, one per
 * album, newest album first. Covers with a file on the device come first,
 * so the stack still shows art offline: an album's slot goes to one of its
 * songs with a stored cover when it has one, and an album without any only
 * fills a slot when there aren't enough of those.
 */
export function summarizeDownloads(
  records: readonly Readonly<DownloadRecord>[],
  { ready, coverLimit = RECENT_COVER_LIMIT }: { ready: boolean; coverLimit?: number },
): DownloadSummary {
  let bytes = 0;
  // The album behind each stored cover file, from the records that know it,
  // so a record older than the track snapshot still finds its album.
  const albumByCover = new Map<string, string>();
  for (const record of records) {
    if (Number.isFinite(record.size) && record.size > 0) bytes += record.size;
    if (record.coverFilename && record.track?.album_id) {
      albumByCover.set(record.coverFilename, record.track.album_id);
    }
  }
  const albumKey = (record: Readonly<DownloadRecord>): string => {
    const album =
      record.track?.album_id ||
      (record.coverFilename ? albumByCover.get(record.coverFilename) : undefined);
    if (album) return `album:${album}`;
    return record.coverFilename ? `cover:${record.coverFilename}` : `track:${record.trackId}`;
  };

  // Newest first, so each album is placed by its latest download.
  const newestFirst = [...records].sort((a, b) => b.downloadedAt - a.downloadedAt);
  const albums = new Map<string, { record: Readonly<DownloadRecord>; latest: number }>();
  for (const record of newestFirst) {
    if (!record.coverFilename && record.track?.has_cover === false) continue;
    const key = albumKey(record);
    const album = albums.get(key);
    if (!album) albums.set(key, { record, latest: record.downloadedAt });
    else if (!album.record.coverFilename && record.coverFilename) album.record = record;
  }
  const candidates = [...albums.values()];
  const recent = [
    ...candidates.filter((album) => album.record.coverFilename),
    ...candidates.filter((album) => !album.record.coverFilename),
  ]
    .slice(0, coverLimit)
    .sort((a, b) => b.latest - a.latest)
    .map(({ record }) => ({ trackId: record.trackId, track: record.track }));

  return { ready, count: records.length, bytes, recent };
}

type SummarySource = Pick<DownloadStore, "getVersion" | "listRecords" | "ready">;

const snapshots = new WeakMap<SummarySource, { version: number; summary: DownloadSummary }>();

/**
 * The summary for the store as of its last change. The same object comes
 * back until the store changes again, as `useSyncExternalStore` requires.
 */
export function downloadSummarySnapshot(store: SummarySource): DownloadSummary {
  const version = store.getVersion();
  const cached = snapshots.get(store);
  if (cached?.version === version) return cached.summary;
  const summary = summarizeDownloads(store.listRecords(), { ready: store.ready });
  snapshots.set(store, { version, summary });
  return summary;
}

/** The live download summary; re-renders when a download lands or goes. */
export function useDownloadSummary(): DownloadSummary {
  // `downloadStore` is swapped on account change, so it's read per render.
  const store = downloadStore;
  const snapshot = () => downloadSummarySnapshot(store);
  // Three arguments for web prerendering, like the other offline hooks.
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}
