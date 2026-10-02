import type { MusicRoot, RescanStatus } from "../api";

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
