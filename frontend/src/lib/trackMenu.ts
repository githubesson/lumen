import type { TrackListItem } from "../api";
import { displayText } from "./format";

/**
 * The server takes at most this many track ids per add-to-playlist request
 * (`maxPlaylistTrackAddBatch` in the backend's playlist handlers).
 */
export const PLAYLIST_ADD_BATCH = 1000;

/** `ids` cut into requests the server accepts. */
export function addBatches(ids: readonly string[], size = PLAYLIST_ADD_BATCH): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Each track once, in list order. A playlist can hold a track twice, and its
 * selection is by track, so both rows come back selected.
 */
export function uniqueTracks<T extends Pick<TrackListItem, "id">>(tracks: readonly T[]): T[] {
  const seen = new Set<string>();
  return tracks.filter((track) => !seen.has(track.id) && !!seen.add(track.id));
}

/**
 * The tracks whose covers stack up for a selection: one per track up to
 * `max`, in list order. Different albums come first so the stack shows as
 * many covers as it can; a selection from one album repeats its cover, so it
 * still reads as several tracks.
 */
export function selectionCovers(tracks: readonly TrackListItem[], max = 3): TrackListItem[] {
  const count = Math.min(max, tracks.length);
  const seen = new Set<string>();
  const picked = new Set<number>();
  tracks.forEach((track, index) => {
    const key = track.album_id ?? track.cover_url ?? track.album_title ?? track.id;
    if (picked.size < count && !seen.has(key)) {
      seen.add(key);
      picked.add(index);
    }
  });
  for (let index = 0; picked.size < count; index++) picked.add(index);
  return [...picked].sort((a, b) => a - b).map((index) => tracks[index]);
}

/** A selection's artists, each once, in list order. */
export function selectionArtists(tracks: readonly TrackListItem[]): string {
  const names = new Set<string>();
  for (const track of tracks) {
    const name = displayText(track.artist);
    if (name) names.add(name);
  }
  return [...names].join(", ");
}

/** Whether all, some, or none of `tracks` are favorites. */
export function favoriteState(
  tracks: readonly Pick<TrackListItem, "id">[],
  isFavorite: (id: string) => boolean,
): "all" | "some" | "none" {
  const count = tracks.filter((track) => isFavorite(track.id)).length;
  if (count === 0) return "none";
  return count === tracks.length ? "all" : "some";
}

/**
 * The ids the Favorite action toggles: every favorite when all of them are
 * (it removes them), else the ones not yet favorited (it adds those).
 */
export function favoriteToggleIds(
  tracks: readonly Pick<TrackListItem, "id">[],
  isFavorite: (id: string) => boolean,
): string[] {
  const all = favoriteState(tracks, isFavorite) === "all";
  return tracks.filter((track) => isFavorite(track.id) === all).map((track) => track.id);
}

/** Runs `task` over `items` with at most `limit` in flight. */
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<unknown>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await task(items[cursor++]);
    }),
  );
}
