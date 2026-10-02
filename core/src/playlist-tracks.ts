import type { PlaylistTracks } from "./api";

/**
 * Optimistic track-list edits for the playlist screens, and the values both
 * screens derive from the list.
 *
 * Removal is addressed by `position`, so an optimistic list has to carry the
 * positions the server will have given the remaining rows, or the next
 * removal targets the wrong one. Positions on the client can have gaps:
 * the server numbers every row, including other users' personal uploads and
 * deleted tracks, which it leaves out of the list it sends.
 */

/** While TIDAL tracks are queued for download, refetch so rows flip to their library copies. */
export const PLAYLIST_AUTO_DOWNLOAD_REFRESH_MS = 20_000;

/** Rows still on TIDAL: with auto-download on, these are queued for the library. */
export function queuedTidalCount(entries: readonly { source?: string }[]): number {
  let count = 0;
  for (const entry of entries) if (entry.source === "tidal") count += 1;
  return count;
}

/**
 * How many entries auto-download is still saving, as the server counts them.
 * That leaves out failed downloads, which wait out a backoff of up to a day:
 * counting every row still on TIDAL kept a screen polling and showing them as
 * "saving" all that time. Servers without `tidal_queued` fall back to it.
 */
export function playlistTidalQueued(
  data: Pick<PlaylistTracks, "tracks" | "tidal_queued"> | undefined,
): number {
  return data?.tidal_queued ?? queuedTidalCount(data?.tracks ?? []);
}

/**
 * The list after removing the row at `position`. Like the server, every later
 * row moves up one, hidden rows included, so each keeps its own gap. Rows
 * whose position doesn't change keep their identity. Unchanged when no row
 * has that position (the server answers 404 and shifts nothing).
 */
export function removePlaylistEntry<T extends { position: number }>(
  entries: readonly T[],
  position: number,
): T[] {
  if (!entries.some((entry) => entry.position === position)) return [...entries];
  const out: T[] = [];
  for (const entry of entries) {
    if (entry.position === position) continue;
    out.push(entry.position > position ? { ...entry, position: entry.position - 1 } : entry);
  }
  return out;
}

/**
 * The list after dragging the row at index `from` to index `to`. The server
 * puts the rows you can see back into the slots they held, in the new order,
 * so the positions stay the same set. (It also prunes rows for deleted tracks
 * on a reorder, renumbering what follows; the client can't tell those gaps
 * from other users' rows, so the refetch after the edit settles them.)
 */
export function movePlaylistEntry<T extends { position: number }>(
  entries: readonly T[],
  from: number,
  to: number,
): T[] {
  const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < entries.length;
  if (from === to || !inRange(from) || !inRange(to)) return [...entries];
  const moved = [...entries];
  const [entry] = moved.splice(from, 1);
  moved.splice(to, 0, entry);
  const slots = entries.map((e) => e.position).sort((a, b) => a - b);
  return moved.map((e, i) => (e.position === slots[i] ? e : { ...e, position: slots[i] }));
}
