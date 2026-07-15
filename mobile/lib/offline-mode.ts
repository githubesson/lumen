import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { useSyncExternalStore } from "react";
import { downloadStore } from "./downloads/download-store";

/**
 * App-wide offline state, Spotify-style: offline is device connectivity loss
 * (NetInfo) OR the user's persisted "Offline mode" switch. Server-unreachable
 * while connected is intentionally NOT offline. Module singleton consumed via
 * `useSyncExternalStore`, mirroring {@link downloadStore}.
 */

const FORCED_KEY = "offline-mode.forced.v1"; // AsyncStorage; "1" | "0"

type Listener = () => void;

class OfflineStore {
  // NetInfo isConnected === null (cold start, unknown) counts as ONLINE so the
  // banner never flashes during launch. Only an explicit `false` is offline.
  private connected = true;
  private forced = false;
  private started = false;
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  isOffline = (): boolean => this.forced || !this.connected;

  isForced = (): boolean => this.forced;

  /** Idempotent: subscribe to NetInfo and load the persisted forced flag. */
  start(): void {
    if (this.started) return;
    this.started = true;
    NetInfo.addEventListener((state) => {
      const connected = state.isConnected !== false;
      if (connected === this.connected) return;
      this.connected = connected;
      this.emit();
    });
    void AsyncStorage.getItem(FORCED_KEY)
      .then((raw) => {
        const forced = raw === "1";
        if (forced === this.forced) return;
        this.forced = forced;
        this.emit();
      })
      .catch(() => {
        // Best effort — an unreadable flag just means "not forced".
      });
  }

  setForced(value: boolean): void {
    if (value === this.forced) return;
    this.forced = value;
    this.emit();
    // Persistence is best-effort; the in-memory flag drives this session.
    AsyncStorage.setItem(FORCED_KEY, value ? "1" : "0").catch(() => {});
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const offlineStore = new OfflineStore();

/**
 * Stable identity; reads live singleton state. Passed to `usePlayerCore` as
 * the queue-advance gate: offline → only downloaded tracks are playable.
 */
export function isTrackPlayableOffline(trackId: string): boolean {
  return !offlineStore.isOffline() || downloadStore.isDownloaded(trackId);
}

export function useIsOffline(): boolean {
  return useSyncExternalStore(offlineStore.subscribe, offlineStore.isOffline);
}

export function useOfflineForced(): boolean {
  return useSyncExternalStore(offlineStore.subscribe, offlineStore.isForced);
}

/** offline AND not downloaded → row is dimmed/unplayable. */
export function useTrackUnavailableOffline(trackId: string): boolean {
  const offline = useIsOffline();
  const downloaded = useSyncExternalStore(downloadStore.subscribe, () =>
    downloadStore.isDownloaded(trackId),
  );
  return offline && !downloaded;
}
