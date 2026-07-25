import type { QueryClient } from '@tanstack/react-query';

/**
 * Centralized React Query key factory, mirroring `mobile/lib/query-keys.ts`.
 *
 * Every read and every `invalidateQueries`/`setQueryData` write must build its
 * key here so the two can never drift into mismatched namespaces: React Query
 * matches by prefix, so a write targeting a short prefix only invalidates the
 * reads beneath it if both sides agree on that prefix.
 *
 * Namespaces:
 *  - `["user", userId, …]` for anything tied to the signed-in account, so
 *    invalidating {@link qk.userRoot} refreshes the whole account at once and
 *    switching accounts cannot show the previous user's data.
 *  - `["tracks" | "albums" | "artists", search?]` for paginated browse lists;
 *    call with no argument for the invalidation root.
 */

export type UserId = string | undefined;
type Id = string | undefined;

export const qk = {
  /** Root of every user-scoped key; invalidating this refreshes the account. */
  userRoot: ['user'] as const,

  // ---- user-scoped ----
  playlists: (userId: UserId) => ['user', userId, 'playlists'] as const,
  playlist: (userId: UserId, id: Id) => ['user', userId, 'playlist', id] as const,
  playlistTracks: (userId: UserId, id: Id) =>
    ['user', userId, 'playlist-tracks', id] as const,
  playlistCollaborators: (userId: UserId, id: Id) =>
    ['user', userId, 'playlist-collaborators', id] as const,

  favorites: (userId: UserId) => ['user', userId, 'favorites'] as const,
  recent: (userId: UserId) => ['user', userId, 'recent'] as const,
  replay: (userId: UserId, range: string) =>
    ['user', userId, 'replay', range] as const,
  /** Home's daily album dig; the seed is the day, so it rotates once a day. */
  homeRediscover: (userId: UserId, seed: string) =>
    ['user', userId, 'home-rediscover', seed] as const,

  album: (userId: UserId, id: Id) => ['user', userId, 'album', id] as const,
  albumTracks: (userId: UserId, id: Id) =>
    ['user', userId, 'album-tracks', id] as const,
  artist: (userId: UserId, id: Id) => ['user', userId, 'artist', id] as const,
  artistTracks: (userId: UserId, id: Id) =>
    ['user', userId, 'artist-tracks', id] as const,

  // ---- browse lists (server already scopes these to the caller) ----
  tracksList: (search?: string) =>
    (search ? (['tracks', search] as const) : (['tracks'] as const)),
  albumsList: (search?: string) =>
    (search ? (['albums', search] as const) : (['albums'] as const)),
  artistsList: (search?: string) =>
    (search ? (['artists', search] as const) : (['artists'] as const)),
} as const;

/**
 * Refresh everything that depends on library contents. Used after a mutation
 * whose blast radius is wider than one screen (favoriting from a list, adding
 * to a playlist) and on the `libraryChanged` event from core.
 */
export function invalidateLibrary(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: qk.userRoot });
  void client.invalidateQueries({ queryKey: qk.tracksList() });
  void client.invalidateQueries({ queryKey: qk.albumsList() });
  void client.invalidateQueries({ queryKey: qk.artistsList() });
}
