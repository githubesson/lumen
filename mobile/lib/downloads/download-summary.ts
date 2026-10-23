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
 * Count, size and a few recent covers of the stored downloads. Covers with a
 * file on the device come first, so the stack still shows art offline; a song
 * without one only fills a slot when there aren't enough of those. One cover
 * per album.
 */
export function summarizeDownloads(
  records: readonly Readonly<DownloadRecord>[],
  { ready, coverLimit = RECENT_COVER_LIMIT }: { ready: boolean; coverLimit?: number },
): DownloadSummary {
  let bytes = 0;
  for (const record of records) {
    if (Number.isFinite(record.size) && record.size > 0) bytes += record.size;
  }

  const newestFirst = [...records].sort((a, b) => b.downloadedAt - a.downloadedAt);
  const seen = new Set<string>();
  const stored: Readonly<DownloadRecord>[] = [];
  const remote: Readonly<DownloadRecord>[] = [];
  for (const record of newestFirst) {
    if (stored.length >= coverLimit) break;
    if (!record.coverFilename && record.track?.has_cover === false) continue;
    const key = record.coverFilename ?? record.track?.album_id ?? record.trackId;
    if (seen.has(key)) continue;
    seen.add(key);
    (record.coverFilename ? stored : remote).push(record);
  }
  const recent = [...stored, ...remote]
    .slice(0, coverLimit)
    .sort((a, b) => b.downloadedAt - a.downloadedAt)
    .map((record) => ({ trackId: record.trackId, track: record.track }));

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
