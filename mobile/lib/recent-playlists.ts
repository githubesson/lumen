import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * The playlists a user last added tracks to, newest first, so the
 * add-to-playlist picker can put them at the top. Kept per account on the
 * device, under the key the picker has always used.
 */

const RECENT_PLAYLISTS_KEY = "mlib-recent-add-playlists";
const MAX_RECENT_PLAYLISTS = 6;

export function recentPlaylistsKey(userId: string): string {
  return `${RECENT_PLAYLISTS_KEY}:${userId}`;
}

/** The stored list, or none when it's missing or malformed. */
export function parseRecentPlaylistIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const ids: unknown = JSON.parse(raw);
    return Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

/** `ids` with `id` moved (or added) to the front, capped. */
export function withRecentPlaylist(ids: readonly string[], id: string): string[] {
  return [id, ...ids.filter((other) => other !== id)].slice(
    0,
    MAX_RECENT_PLAYLISTS,
  );
}

export async function loadRecentPlaylistIds(userId: string): Promise<string[]> {
  return parseRecentPlaylistIds(
    await AsyncStorage.getItem(recentPlaylistsKey(userId)),
  );
}

// Writes run one at a time, so two adds in quick succession can't each read
// the list before the other's write and drop one of them.
let pendingWrite: Promise<void> = Promise.resolve();

/** Records an add to `playlistId`. Never rejects: losing the hint is harmless. */
export function rememberRecentPlaylist(
  userId: string,
  playlistId: string,
): Promise<void> {
  pendingWrite = pendingWrite.then(async () => {
    try {
      const ids = await loadRecentPlaylistIds(userId);
      await AsyncStorage.setItem(
        recentPlaylistsKey(userId),
        JSON.stringify(withRecentPlaylist(ids, playlistId)),
      );
    } catch {
      // The track is already added; only the ordering hint is lost.
    }
  });
  return pendingWrite;
}
