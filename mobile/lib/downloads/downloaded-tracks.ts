import { useSyncExternalStore } from "react";
import type { TrackListItem } from "@music-library/core";
import {
  downloadStore,
  type DownloadRecord,
  type DownloadStore,
} from "./download-store";

/** The downloaded songs as the Downloads screen lists them. */
export interface DownloadedTracks {
  /** Each download's track snapshot, newest download first. */
  tracks: TrackListItem[];
  /**
   * Downloads from before records carried a snapshot, with nothing to draw
   * a row from. Opening their playlist online fills it in.
   */
  unlisted: number;
}

/** The stored downloads as rows, newest download first. */
export function listDownloadedTracks(
  records: readonly Readonly<DownloadRecord>[],
): DownloadedTracks {
  const listed = records.filter((record) => record.track);
  listed.sort((a, b) => b.downloadedAt - a.downloadedAt);
  return {
    tracks: listed.map((record) => record.track!),
    unlisted: records.length - listed.length,
  };
}

type TracksSource = Pick<DownloadStore, "getVersion" | "listRecords">;

const snapshots = new WeakMap<TracksSource, { version: number; tracks: DownloadedTracks }>();

/**
 * The list for the store as of its last change. The same object comes back
 * until the store changes again, as `useSyncExternalStore` requires.
 */
export function downloadedTracksSnapshot(store: TracksSource): DownloadedTracks {
  const version = store.getVersion();
  const cached = snapshots.get(store);
  if (cached?.version === version) return cached.tracks;
  const tracks = listDownloadedTracks(store.listRecords());
  snapshots.set(store, { version, tracks });
  return tracks;
}

/** The live list; re-renders when a download lands or goes. */
export function useDownloadedTracks(): DownloadedTracks {
  // `downloadStore` is swapped on account change, so it's read per render.
  const store = downloadStore;
  const snapshot = () => downloadedTracksSnapshot(store);
  // Three arguments for web prerendering, like the other offline hooks.
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}
