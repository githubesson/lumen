import type { MusicRoot, RescanStatus } from "../api";
import { pluralize } from "../format";

/** Last path segment, for either separator (the server may run on Windows). */
function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

export function musicRootName(
  root: Pick<MusicRoot, "primary" | "label" | "path">,
): string {
  return root.primary ? "Primary" : root.label || basename(root.path);
}

/** List key: the primary root comes back without an id, and paths are unique. */
export function musicRootKey(root: Pick<MusicRoot, "id" | "path">): string {
  return root.id || `path:${root.path}`;
}

/**
 * The primary root is MUSIC_PATH: always watched, and returned with a blank id
 * because it has no row to pause or remove.
 */
export function canManageMusicRoot(
  root: Pick<MusicRoot, "id" | "primary">,
): boolean {
  return !root.primary && !!root.id;
}

/**
 * What removing a root can do with its tracks. Inside another watched root
 * they stay scanned, so purging them would only last until the next scan
 * brought them back as new rows, minus their history.
 */
export function musicRootRemoval(root: Pick<MusicRoot, "covered_by">): {
  canPurge: boolean;
  coveredBy: string | null;
} {
  const coveredBy = root.covered_by || null;
  return { canPurge: coveredBy === null, coveredBy };
}

/** Removing a root changes the library only when tracks were purged. */
export function rootRemovalChangedLibrary(result: {
  purged: boolean;
  deletedTracks: number | null | undefined;
}): boolean {
  return result.purged && (result.deletedTracks ?? 0) > 0;
}

/**
 * Whether a rescan that just finished changed the library: one that went
 * through no files and pruned none left it as it was.
 */
export function rescanChangedLibrary(
  status: RescanStatus | null | undefined,
): boolean {
  return (
    !!status &&
    !status.running &&
    ((status.processed ?? 0) > 0 || (status.pruned ?? 0) > 0)
  );
}

/**
 * A running scan's progress, or null when none is running. `count` is
 * "12 / 40" ("12 / ?" until the scan has counted its files); `detail` adds
 * what came of them.
 */
export function rescanProgress(
  status: RescanStatus | null | undefined,
): { count: string; detail: string } | null {
  if (!status?.running) return null;
  const count = `${status.processed ?? 0} / ${status.total ?? "?"}`;
  return {
    count,
    detail: `${count} processed · ${status.inserted ?? 0} inserted · ${status.dedup ?? 0} deduped · ${pluralize(status.errored ?? 0, "error")}`,
  };
}

export const RESCAN_POLL_MS = 2000;
export const MAX_RESCAN_POLL_FAILURES = 5;

export interface WatchRescanOptions {
  /** One status read, e.g. `(signal) => api.rescanStatus({ signal })`. */
  fetchStatus: (signal?: AbortSignal) => Promise<RescanStatus>;
  /** Each status read, the finished one included, for showing progress. */
  onStatus?: (status: RescanStatus) => void;
  /** Between reads; defaults to `RESCAN_POLL_MS`. */
  intervalMs?: number;
  /** Failed reads in a row before giving up; defaults to `MAX_RESCAN_POLL_FAILURES`. */
  maxFailures?: number;
  /** Skip reads while this is true, such as while the page is hidden. */
  isPaused?: () => boolean;
  /** Stops the watch, cancelling a read in flight. */
  signal?: AbortSignal;
}

/**
 * Poll the rescan status until the scan is idle, reading at once and then
 * every `intervalMs`. Resolves with the finished status, for
 * `rescanChangedLibrary`, or null when stopped first: by `signal`, or after
 * `maxFailures` failed reads in a row (signed out, lost admin, server gone)
 * rather than polling those forever. Start it for a scan known to run (just
 * started, or a status read saying so), not on an idle status: that still
 * carries the last scan's counts.
 */
export async function watchRescan({
  fetchStatus,
  onStatus,
  intervalMs = RESCAN_POLL_MS,
  maxFailures = MAX_RESCAN_POLL_FAILURES,
  isPaused,
  signal,
}: WatchRescanOptions): Promise<RescanStatus | null> {
  let failures = 0;
  for (;;) {
    if (signal?.aborted) return null;
    if (!isPaused?.()) {
      try {
        const status = await fetchStatus(signal);
        if (signal?.aborted) return null;
        failures = 0;
        onStatus?.(status);
        if (!status.running) return status;
      } catch {
        if (signal?.aborted) return null;
        failures += 1;
        if (failures >= maxFailures) return null;
      }
    }
    if (!(await delay(intervalMs, signal))) return null;
  }
}

/** Wait `ms`; false when `signal` aborts first. */
function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The add-root request, or null while there's no path to add. */
export function addMusicRootInput(
  path: string,
  label: string,
): { path: string; label?: string } | null {
  const trimmedPath = path.trim();
  if (!trimmedPath) return null;
  const trimmedLabel = label.trim();
  return trimmedLabel
    ? { path: trimmedPath, label: trimmedLabel }
    : { path: trimmedPath };
}
