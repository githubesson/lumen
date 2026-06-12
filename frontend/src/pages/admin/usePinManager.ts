import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorMessage, isValidPinID } from "../../api";
import { libraryChanged } from "../../lib/events";

/** Minimal shape every pin (ArtistGrid tracker / Filen share) shares. */
export interface PinLike {
  id: string;
  enabled: boolean;
  root_exists: boolean;
  scan_interval_seconds: number;
  last_scan_at?: string | null;
  last_error?: string;
}

/** Minimal shape every download row shares. */
export interface DownloadLike {
  id: number;
  status: "downloaded" | "existing" | "skipped" | "failed";
}

export interface PinManagerConfig<Pin extends PinLike, Download extends DownloadLike> {
  /** Fetch all pins. */
  list: () => Promise<Pin[]>;
  /** Patch a pin by id. */
  update: (id: string, patch: { enabled: boolean }) => Promise<unknown>;
  /** Delete a pin by id. */
  remove: (id: string) => Promise<unknown>;
  /** Trigger a scan for a pin by id. */
  scan: (id: string) => Promise<unknown>;
  /** Fetch recent downloads for a pin. */
  listDownloads: (id: string, limit: number) => Promise<Download[]>;
  /** Human label for this source, used in error copy ("Tracker" / "Filen share"). */
  kind: string;
  /** Confirmation prompt shown before removing a pin. */
  confirmRemove: (pin: Pin) => string;
  /** Report errors to the shared section error banner (empty string clears). */
  onError: (message: string) => void;
}

export interface PinManager<Pin extends PinLike, Download extends DownloadLike> {
  pins: Pin[] | null;
  busyPins: Set<string>;
  historyPinID: string | null;
  downloadsByPin: Record<string, Download[]>;
  reload: () => Promise<void>;
  togglePin: (pin: Pin) => void;
  removePin: (pin: Pin) => void;
  scanPin: (pin: Pin) => void;
  toggleHistory: (pinID: string) => void;
  loadDownloads: (pinID: string) => void;
}

const missingIDMessage = (kind: string) =>
  `This ${kind} is missing its pin id. Refresh sources or restart the backend.`;

/**
 * Generic controller for a pin source (ArtistGrid trackers or Filen shares).
 * Owns the pin list, per-pin busy set, expandable download history, and the
 * scan/toggle/remove lifecycle. The two former hand-rolled blocks differed only
 * by which API functions and download field they used — captured here via the
 * `config` parameter so the presentational components stay shared.
 */
export function usePinManager<Pin extends PinLike, Download extends DownloadLike>(
  config: PinManagerConfig<Pin, Download>,
): PinManager<Pin, Download> {
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [busyPins, setBusyPins] = useState<Set<string>>(() => new Set());
  const [historyPinID, setHistoryPinID] = useState<string | null>(null);
  const [downloadsByPin, setDownloadsByPin] = useState<Record<string, Download[]>>(
    {},
  );

  // Always read the latest config (parent re-creates it each render).
  const cfg = useRef(config);
  cfg.current = config;

  // Track follow-up re-fetch timers so they can be cleared on unmount or before
  // re-scheduling. Previously these were untracked setTimeout calls that orphaned
  // (and fired setState on an unmounted component) when the section was closed.
  const scanTimersRef = useRef<Map<string, number[]>>(new Map());

  const clearScanTimers = useCallback((id?: string) => {
    const timers = scanTimersRef.current;
    if (id === undefined) {
      timers.forEach((ids) => ids.forEach((t) => window.clearTimeout(t)));
      timers.clear();
      return;
    }
    timers.get(id)?.forEach((t) => window.clearTimeout(t));
    timers.delete(id);
  }, []);

  useEffect(() => clearScanTimers, [clearScanTimers]);

  const reload = useCallback(async () => {
    try {
      const next = await cfg.current.list();
      setPins(next);
      setHistoryPinID((current) =>
        current && next.some((pin) => pin.id === current) ? current : null,
      );
    } catch (err) {
      cfg.current.onError(errorMessage(err, `Failed to load ${cfg.current.kind}s.`));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadDownloadsRaw = useCallback(async (id: string) => {
    if (!isValidPinID(id)) {
      throw new ApiError(0, missingIDMessage(cfg.current.kind));
    }
    const rows = await cfg.current.listDownloads(id, 80);
    setDownloadsByPin((current) => ({ ...current, [id]: rows }));
  }, []);

  const withBusy = useCallback(async (id: string, fn: () => Promise<void>) => {
    setBusyPins((current) => new Set(current).add(id));
    cfg.current.onError("");
    try {
      await fn();
    } catch (err) {
      cfg.current.onError(errorMessage(err, `${cfg.current.kind} update failed.`));
    } finally {
      setBusyPins((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const requireID = useCallback((pin: Pin): string | null => {
    const id = pin.id?.trim() ?? "";
    if (isValidPinID(id)) return id;
    cfg.current.onError(missingIDMessage(cfg.current.kind));
    return null;
  }, []);

  const togglePin = useCallback(
    (pin: Pin) => {
      const id = requireID(pin);
      if (!id) return;
      void withBusy(id, async () => {
        await cfg.current.update(id, { enabled: !pin.enabled });
        await reload();
      });
    },
    [requireID, withBusy, reload],
  );

  const removePin = useCallback(
    (pin: Pin) => {
      const id = requireID(pin);
      if (!id) return;
      if (!window.confirm(cfg.current.confirmRemove(pin))) return;
      void withBusy(id, async () => {
        await cfg.current.remove(id);
        clearScanTimers(id);
        setHistoryPinID((current) => (current === id ? null : current));
        await reload();
      });
    },
    [requireID, withBusy, reload, clearScanTimers],
  );

  const scanPin = useCallback(
    (pin: Pin) => {
      const id = requireID(pin);
      if (!id) return;
      void withBusy(id, async () => {
        await cfg.current.scan(id);
        await reload();
        // The backend scans asynchronously; poll a couple of times so the row
        // and download history catch up once files land. Timers are tracked so
        // they're cancelled on unmount or if the pin is removed/re-scanned.
        clearScanTimers(id);
        const refetch = () => {
          void reload();
          void loadDownloadsRaw(id).catch(() => undefined);
          libraryChanged.emit();
        };
        scanTimersRef.current.set(id, [
          window.setTimeout(refetch, 2500),
          window.setTimeout(refetch, 8000),
        ]);
      });
    },
    [requireID, withBusy, reload, loadDownloadsRaw, clearScanTimers],
  );

  const loadDownloads = useCallback(
    (pinID: string) => {
      const id = pinID.trim();
      if (!isValidPinID(id)) {
        cfg.current.onError(missingIDMessage(cfg.current.kind));
        return;
      }
      void loadDownloadsRaw(id).catch((err) => {
        cfg.current.onError(
          errorMessage(err, `Failed to load ${cfg.current.kind} downloads.`),
        );
      });
    },
    [loadDownloadsRaw],
  );

  const toggleHistory = useCallback(
    (pinID: string) => {
      const id = pinID.trim();
      if (!isValidPinID(id)) {
        cfg.current.onError(missingIDMessage(cfg.current.kind));
        return;
      }
      setHistoryPinID((current) => current === id ? null : id);
    },
    [],
  );

  // When a history pin is opened and its downloads aren't cached yet, fetch them.
  useEffect(() => {
    if (!historyPinID || downloadsByPin[historyPinID]) return;
    void loadDownloadsRaw(historyPinID).catch((err) => {
      cfg.current.onError(
        errorMessage(err, `Failed to load ${cfg.current.kind} downloads.`),
      );
    });
  }, [historyPinID, downloadsByPin, loadDownloadsRaw]);

  return {
    pins,
    busyPins,
    historyPinID,
    downloadsByPin,
    reload,
    togglePin,
    removePin,
    scanPin,
    toggleHistory,
    loadDownloads,
  };
}

/** Summarise download statuses for the per-pin status cell. */
export function downloadCounts(rows?: DownloadLike[]): string | null {
  if (!rows?.length) return null;
  const counts = rows.reduce(
    (acc, row) => {
      acc[row.status] += 1;
      return acc;
    },
    { downloaded: 0, existing: 0, skipped: 0, failed: 0 },
  );
  const parts = [
    counts.downloaded ? `${counts.downloaded} new` : "",
    counts.existing ? `${counts.existing} existing` : "",
    counts.failed ? `${counts.failed} failed` : "",
    counts.skipped ? `${counts.skipped} skipped` : "",
  ].filter(Boolean);
  return parts.join(" / ") || null;
}
