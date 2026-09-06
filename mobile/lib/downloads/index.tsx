import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppState, Platform } from "react-native";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import type { TrackListItem } from "@music-library/core";
import { downloadStore, playlistOwner, setDownloadAccount } from "./download-store";
import { setAutoDownloadAccount } from "./auto-download";
import { diagnosticsLog } from "../diagnostics/log";
import { offlineStore } from "../offline-mode";

export {
  downloadStore,
  playlistOwner,
  sessionCookieHeader,
  type DownloadRecord,
  type DownloadPhase,
} from "./download-store";

export { autoDownloadStore, useAutoDownload } from "./auto-download";

/**
 * Hydrates the offline store once for the app. Mount high in the tree so the
 * in-memory record map is populated before the player resolves any track URI.
 *
 * Also drives auto-download syncs for opted-in playlists: once at startup, on
 * return to foreground, and whenever connectivity comes back.
 */
export function DownloadsProvider({ children, accountId }: { children: ReactNode; accountId: string | null }) {
  const [readyAccount, setReadyAccount] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const downloads = setDownloadAccount(accountId);
    const autoDownloads = setAutoDownloadAccount(downloads);
    setReadyAccount(accountId);
    // The log deliberately depends on nothing but the filesystem, so the app
    // hands it the ambient context here. `appState` is what identifies a
    // failure that happened during an unattended background sync.
    diagnosticsLog.configure({
      context: () => ({
        net: offlineStore.isOffline() ? "offline" : "online",
        appState: AppState.currentState,
      }),
      describeBuild,
    });
    void downloads.hydrate();
    if (accountId) void autoDownloads.syncAll();

    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active" && accountId) void autoDownloads.syncAll();
    });

    // The offline store already owns the NetInfo subscription and the user's
    // forced-offline switch; fire only on transitions back to online so we
    // don't retry against a connection we know is down.
    let wasOffline = offlineStore.isOffline();
    const unsubscribeOffline = offlineStore.subscribe(() => {
      const offline = offlineStore.isOffline();
      if (wasOffline && !offline && accountId) void autoDownloads.syncAll();
      wasOffline = offline;
    });

    return () => {
      downloads.retire();
      autoDownloads.retire();
      appStateSub.remove();
      unsubscribeOffline();
    };
  }, [accountId]);
  return readyAccount === accountId ? <>{children}</> : null;
}

/**
 * One-line build identity for the head of each log session, so a log copied
 * out of the app says which binary and which OTA update produced it.
 * `expo-updates` is inert in a dev client, where these read as null.
 */
function describeBuild(): string {
  const version = Constants.expoConfig?.version ?? "?";
  const update = Updates.isEmbeddedLaunch
    ? "embedded"
    : (Updates.updateId ?? "none");
  const channel = Updates.channel ? ` · ${Updates.channel}` : "";
  return `${version} · ${Platform.OS} ${Platform.Version} · update ${update}${channel}`;
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
