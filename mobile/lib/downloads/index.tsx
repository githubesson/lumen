import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { TrackListItem } from "@music-library/core";
import { downloadStore, playlistOwner } from "./download-store";

export {
  downloadStore,
  playlistOwner,
  type DownloadRecord,
  type DownloadPhase,
} from "./download-store";

/**
 * Hydrates the offline store once for the app. Mount high in the tree so the
 * in-memory record map is populated before the player resolves any track URI.
 */
export function DownloadsProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void downloadStore.hydrate();
  }, []);
  return <>{children}</>;
}

export type PlaylistDownloadStatus =
  | "idle"
  | "downloading"
  | "downloaded"
  | "partial";

export interface PlaylistDownloadState {
  status: PlaylistDownloadStatus;
  total: number;
  downloaded: number;
  active: number;
  ready: boolean;
}

/**
 * Reactive offline state for a set of tracks (a playlist). Re-renders on any
 * store mutation and reports how many of the tracks are already stored, so the
 * download control can show progress and a downloaded/partial state.
 */
export function usePlaylistDownload(
  tracks: TrackListItem[],
): PlaylistDownloadState {
  const version = useSyncExternalStore(
    downloadStore.subscribe,
    downloadStore.getVersion,
    downloadStore.getVersion,
  );
  return useMemo(() => {
    let downloaded = 0;
    let active = 0;
    for (const track of tracks) {
      if (downloadStore.isDownloaded(track.id)) downloaded += 1;
      else if (downloadStore.isActive(track.id)) active += 1;
    }
    const total = tracks.length;
    const status: PlaylistDownloadStatus =
      active > 0
        ? "downloading"
        : total > 0 && downloaded === total
          ? "downloaded"
          : downloaded > 0
            ? "partial"
            : "idle";
    return { status, total, downloaded, active, ready: downloadStore.ready };
    // `version` is the external-store snapshot: recompute on every mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, version]);
}

/** Whether a playlist currently owns at least one downloaded track. */
export function usePlaylistDownloaded(playlistId: string): boolean {
  // The third argument is required: app.json sets web.output "static", so Expo
  // Router prerenders on the server and React throws "Missing getServerSnapshot"
  // for two-argument calls, failing `expo export --platform web`.
  const snapshot = () => downloadStore.hasOwner(playlistOwner(playlistId));
  return useSyncExternalStore(downloadStore.subscribe, snapshot, snapshot);
}

/**
 * Offline snapshots of a playlist's downloaded tracks, in stored order.
 * Fallback data source for the playlist screen when the query cache has
 * nothing to show — only stored tracks with snapshots appear.
 */
export function useDownloadedPlaylistTracks(playlistId: string): TrackListItem[] {
  const version = useSyncExternalStore(
    downloadStore.subscribe,
    downloadStore.getVersion,
    downloadStore.getVersion,
  );
  // `version` is the external-store snapshot: recompute on every mutation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(
    () => downloadStore.tracksForOwner(playlistOwner(playlistId)),
    [playlistId, version],
  );
}
