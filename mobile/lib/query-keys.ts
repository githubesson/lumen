import type { QueryClient } from "@tanstack/react-query";

/**
 * Centralized React Query key factory.
 *
 * Every `useQuery` / `useInfiniteQuery` read and every
 * `invalidateQueries` / `setQueryData` write must build its key here so reads
 * and writes can never drift into mismatched namespaces. React Query matches
 * keys by prefix from index 0, so a write that targets a shorter prefix
 * invalidates every longer key beneath it — which only works if both sides
 * agree on that prefix. Hand-spelling keys at each call site is exactly how
 * that agreement was lost before (e.g. a read under `["user", id, "playlists"]`
 * that a write tried to invalidate with `["playlists"]`, which never matched).
 *
 * Namespaces:
 *  - User-scoped `["user", userId, …]` for anything tied to the signed-in
 *    account (library detail, favorites, recent, playlists). Invalidating
 *    {@link qk.userRoot} refreshes them all at once.
 *  - Library browse lists `["tracks" | "albums" | "artists", search?]` for the
 *    paginated lists (the backend already scopes these to the caller). Call
 *    with no argument for the invalidation root, with a search term for a read.
 *  - A few standalone keys (share fetch, cover-bust, collaborators) and the
 *    `["admin", …]` keys.
 */

export type UserId = string | undefined;
type Id = string | undefined;

export const qk = {
  /** Root of every user-scoped key; invalidating this refreshes the account. */
  userRoot: ["user"] as const,

  // ---- user-scoped ----
  playlists: (userId: UserId) => ["user", userId, "playlists"] as const,
  playlist: (userId: UserId, id: Id) =>
    ["user", userId, "playlist", id] as const,
  playlistTracks: (userId: UserId, id: Id) =>
    ["user", userId, "playlist-tracks", id] as const,
  playlistInvites: (userId: UserId) =>
    ["user", userId, "playlist-invites"] as const,

  favorites: (userId: UserId) => ["user", userId, "favorites"] as const,
  recent: (userId: UserId) => ["user", userId, "recent"] as const,

  album: (userId: UserId, id: Id) => ["user", userId, "album", id] as const,
  albumTracks: (userId: UserId, id: Id) =>
    ["user", userId, "album-tracks", id] as const,
  artist: (userId: UserId, id: Id) => ["user", userId, "artist", id] as const,
  artistTracks: (userId: UserId, id: Id) =>
    ["user", userId, "artist-tracks", id] as const,
  track: (userId: UserId, id: Id) => ["user", userId, "track", id] as const,

  // ---- library browse lists (search-scoped) ----
  tracksList: (search?: string) =>
    search === undefined ? (["tracks"] as const) : (["tracks", search] as const),
  albumsList: (search?: string) =>
    search === undefined ? (["albums"] as const) : (["albums", search] as const),
  artistsList: (search?: string) =>
    search === undefined
      ? (["artists"] as const)
      : (["artists", search] as const),

  // ---- standalone ----
  /** Cache-bust nonce for an album cover <Image>, bumped after artwork replace. */
  albumCoverBust: (id: Id) => ["album-cover-bust", id] as const,
  /** Public/share track fetch used by the share modal (not user-scoped). */
  shareTrack: (id: Id) => ["track", id] as const,
  playlistCollaborators: (id: Id) =>
    ["playlist-collaborators", id] as const,

  // ---- admin ----
  adminMusicRoots: ["admin", "music-roots"] as const,
  adminRescanStatus: ["admin", "rescan-status"] as const,
  adminInvites: ["admin", "invites"] as const,

  // ---- replay ----
  replay: (periodKey: string) => ["replay", periodKey] as const,

  // ---- home ----
  /** Root of the home screen's library-derived sections. */
  homeRoot: ["home"] as const,
  /** Daily "Rediscover" album sample on the home screen, seeded by date. */
  homeRediscover: (seed: string) => ["home", "rediscover", seed] as const,
} as const;

/**
 * Invalidate every query affected by a library content change — uploads, track
 * deletes, metadata edits, album edits, and admin rescans. This is the single
 * definition of "the library changed": the browse lists plus all user-scoped
 * queries (detail screens, favorites, recent, playlists). The root layout
 * subscribes to {@link libraryChanged} and calls this, so mutation sites only
 * need to `emit()` rather than remember the full invalidation set themselves.
 */
export function invalidateLibrary(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.tracksList() });
  void queryClient.invalidateQueries({ queryKey: qk.albumsList() });
  void queryClient.invalidateQueries({ queryKey: qk.artistsList() });
  void queryClient.invalidateQueries({ queryKey: qk.userRoot });
  void queryClient.invalidateQueries({ queryKey: qk.homeRoot });
}
