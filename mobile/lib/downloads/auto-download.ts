import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { api, playlistEntryToTrack, type TrackListItem } from "@music-library/core";
import { downloadStore, type DownloadStore } from "./download-store";
import { diagnosticsLog } from "../diagnostics/log";
import { offlineStore } from "../offline-mode";

/**
 * Per-playlist "keep this download up to date" flag.
 *
 * A playlist opted in here is re-synced whenever we plausibly have network:
 * app foreground, connectivity regained, and when its screen supplies fresh
 * track data. New entries are downloaded under the same `playlist:<id>` owner
 * the manual button uses, so the two paths share eviction semantics — a track
 * removed from the playlist loses that owner and its file is reclaimed once no
 * other owner remains.
 *
 * Deliberately additive-only on failure: a sync that can't reach the server
 * leaves existing downloads alone rather than treating an empty response as
 * "the playlist is now empty".
 */

const STORAGE_KEY = "auto-download.playlists.v1";

type Listener = () => void;

class AutoDownloadStore {
  private retired = false;
  constructor(private downloads: DownloadStore) {}
  retire(): void { this.retired = true; }
  private get storageKey(): string { return `${STORAGE_KEY}:v2:${this.downloads.accountKey}`; }

  private enabled = new Set<string>();
  private hydrated = false;
  private hydrating: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  /** Playlist ids with an in-flight sync, so concurrent triggers coalesce. */
  private syncing = new Set<string>();
  private version = 0;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  isEnabled = (playlistId: string): boolean => this.enabled.has(playlistId);

  /** Playlist ids currently opted in. */
  enabledIds(): string[] {
    return [...this.enabled];
  }

  hydrate(): Promise<void> {
    if (this.hydrated) return Promise.resolve();
    if (this.hydrating) return this.hydrating;
    this.hydrating = this.doHydrate();
    return this.hydrating;
  }

  private async doHydrate(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(this.storageKey);
      if (this.retired) return;
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === "string" && id) this.enabled.add(id);
        }
      }
    } catch (error) {
      // An unreadable flag set just means nothing is opted in — which silently
      // disables auto-download entirely, so it gets a line.
      diagnosticsLog.append({
        scope: "auto-sync",
        level: "error",
        event: "flags-unreadable",
        message: `Could not read auto-download settings: ${
          error instanceof Error ? error.message || error.name : "unknown error"
        }`,
      });
    }
    this.hydrated = true;
    this.emit();
  }

  private persist(): void {
    AsyncStorage.setItem(this.storageKey, JSON.stringify([...this.enabled])).catch(
      () => {
        // Best effort; the in-memory set drives this session.
      },
    );
  }

  /**
   * Opt a playlist in or out. Enabling immediately downloads whatever the
   * caller already has on screen, then syncs against the server for anything
   * newer. Disabling only clears the flag — existing downloads are kept, since
   * the user asked to stop auto-updating, not to delete their offline copies.
   */
  async setEnabled(
    playlistId: string,
    value: boolean,
    options?: { tracks?: TrackListItem[]; playlistName?: string },
  ): Promise<void> {
    await this.hydrate();
    if (this.retired) return;
    if (value === this.enabled.has(playlistId)) return;
    if (value) this.enabled.add(playlistId);
    else this.enabled.delete(playlistId);
    this.persist();
    this.emit();
    diagnosticsLog.append({
      scope: "auto-sync",
      level: "info",
      event: value ? "auto-enabled" : "auto-disabled",
      message: `Auto-download ${value ? "enabled" : "disabled"} for ${options?.playlistName ?? playlistId}`,
      playlistId,
    });
    if (!value) return;
    if (options?.tracks?.length) {
      await this.downloads.downloadPlaylist(playlistId, options.tracks, {
        playlistName: options.playlistName,
      });
    }
    await this.sync(playlistId, { playlistName: options?.playlistName });
  }

  /**
   * Download any of `tracks` that this playlist doesn't have offline yet.
   * Cheap no-op when the playlist isn't opted in or everything is present, so
   * screens can call it freely as fresh query data arrives.
   */
  async syncWithTracks(
    playlistId: string,
    tracks: TrackListItem[],
    options?: { playlistName?: string },
  ): Promise<void> {
    await this.hydrate();
    if (this.retired) return;
    if (!this.enabled.has(playlistId)) return;
    if (offlineStore.isOffline()) {
      // Worth a line: "auto-download did nothing" and "auto-download thinks
      // it's offline" are indistinguishable from the outside.
      diagnosticsLog.append({
        scope: "auto-sync",
        level: "info",
        event: "sync-skipped-offline",
        message: `Skipped ${options?.playlistName ?? playlistId} — offline`,
        playlistId,
      });
      return;
    }
    await this.downloads.hydrate();
    if (this.retired || !this.enabled.has(playlistId)) return;
    // Existing downloads also need this playlist's ownership. Screen data may
    // be cached, so only sync()'s complete server response removes old owners.
    await this.downloads.downloadPlaylist(playlistId, tracks, {
      playlistName: options?.playlistName,
    });
  }

  /**
   * Fetch the playlist's current tracks and download whatever is missing.
   * Swallows network errors: an unreachable server is the normal offline case,
   * not something to surface mid-background-sync.
   */
  async sync(
    playlistId: string,
    options?: { playlistName?: string },
  ): Promise<void> {
    await this.hydrate();
    if (this.retired) return;
    if (!this.enabled.has(playlistId)) return;
    if (offlineStore.isOffline()) return;
    if (this.syncing.has(playlistId)) return;
    this.syncing.add(playlistId);
    try {
      const response = await api.listPlaylistTracks(playlistId);
      if (this.retired || !this.enabled.has(playlistId) || offlineStore.isOffline()) return;
      if (!Array.isArray(response.tracks) || response.tracks.some(
        (track) => !track || typeof track.track_id !== "string" || !track.track_id,
      )) throw new Error("Invalid playlist track response");
      const tracks = response.tracks.map(playlistEntryToTrack);
      await this.downloads.downloadPlaylist(playlistId, tracks, {
        playlistName: options?.playlistName,
        reconcile: true,
      });
    } catch (error) {
      // Offline or server-side failure: leave existing downloads untouched and
      // retry on the next foreground / reconnect. This is the one failure that
      // used to leave no trace at all — the playlist simply never updated.
      diagnosticsLog.append({
        scope: "auto-sync",
        level: "error",
        event: "sync-failed",
        message: `Could not list tracks for ${options?.playlistName ?? playlistId}: ${
          error instanceof Error ? error.message || error.name : "unknown error"
        }`,
        playlistId,
      });
    } finally {
      this.syncing.delete(playlistId);
    }
  }

  /** Sync every opted-in playlist. Sequential to avoid a burst of requests. */
  async syncAll(): Promise<void> {
    await this.hydrate();
    if (this.retired) return;
    if (offlineStore.isOffline()) return;
    for (const playlistId of this.enabledIds()) {
      await this.sync(playlistId);
    }
  }
}

export let autoDownloadStore = new AutoDownloadStore(downloadStore);
export function setAutoDownloadAccount(downloads: DownloadStore) {
  autoDownloadStore.retire();
  autoDownloadStore = new AutoDownloadStore(downloads);
  return autoDownloadStore;
}

/** Whether a playlist is set to auto-download new entries. */
export function useAutoDownload(playlistId: string): boolean {
  // The third argument is required: app.json sets web.output "static", so Expo
  // Router prerenders on the server and React throws "Missing getServerSnapshot"
  // for two-argument calls, failing `expo export --platform web`.
  const snapshot = () => autoDownloadStore.isEnabled(playlistId);
  return useSyncExternalStore(autoDownloadStore.subscribe, snapshot, snapshot);
}
