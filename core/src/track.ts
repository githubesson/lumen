import type { PlaylistTrackEntry, TrackListItem } from "./api";

/**
 * Predicates over a track's `source`. Shared so the two clients cannot answer
 * "can this be edited / shared?" differently: the web had these as named
 * helpers while the mobile app open-coded `track.source === "tidal"` at six
 * call sites, which is how a rule drifts without anyone noticing.
 */

/** The tracks of a list that can actually be played (see `unavailable`). */
export function playableTracks<T extends TrackListItem>(tracks: readonly T[]): T[] {
  return tracks.filter((track) => !track.unavailable);
}

/**
 * TIDAL tracks of an album listing that aren't in the library and can still
 * be downloaded: what an album download would queue.
 */
export function downloadableAlbumTracks(tracks: readonly TrackListItem[]): TrackListItem[] {
  return tracks.filter((track) => isTidalTrack(track) && !track.unavailable);
}

/** How often album pages refetch while tracks are queued for download. */
export const ALBUM_DOWNLOAD_REFRESH_MS = 15_000;

/**
 * What an admin's album download control offers: progress while tracks are
 * queued, else the whole album when nothing is saved yet or the tracks still
 * missing, else nothing.
 */
export type AlbumDownloadState =
  | { kind: "queued"; queued: number; label: string }
  | { kind: "available"; remaining: number; anySaved: boolean; label: string }
  | { kind: "none" };

export function albumDownloadState(
  tracks: readonly TrackListItem[],
  queuedCount: number,
): AlbumDownloadState {
  if (queuedCount > 0) {
    return { kind: "queued", queued: queuedCount, label: `Downloading · ${queuedCount} left` };
  }
  const remaining = downloadableAlbumTracks(tracks).length;
  if (remaining === 0) return { kind: "none" };
  const anySaved = tracks.some((track) => !isTidalTrack(track));
  return {
    kind: "available",
    remaining,
    anySaved,
    label: anySaved ? `Download ${remaining} remaining` : "Download album",
  };
}

/**
 * Flatten a playlist entry into the list-item shape the players and download
 * store consume. Drops `position`, which is the playlist's ordering rather
 * than a property of the track.
 */
export function playlistEntryToTrack(entry: PlaylistTrackEntry): TrackListItem {
  return {
    id: entry.track_id,
    title: entry.title,
    album_id: entry.album_id,
    album_title: entry.album_title,
    track_no: entry.track_no,
    duration_ms: entry.duration_ms,
    artist: entry.artist,
    has_cover: entry.has_cover,
    cover_url: entry.cover_url,
    source: entry.source,
    source_id: entry.source_id,
    source_album_id: entry.source_album_id,
  };
}

/**
 * A track stored in this library (as opposed to a streaming source like
 * TIDAL). Only local tracks can be edited, moved between albums, or exported
 * as files.
 */
export function isLocalTrack(track: Pick<TrackListItem, "source">): boolean {
  return !track.source || track.source === "local";
}

/**
 * Snippet share links work for local tracks and TIDAL tracks. For TIDAL the
 * backend materializes a hidden track row on share, so the signed public
 * preview endpoints have a stable id from which to build the selected MP4.
 */
export function canShareTrack(track: Pick<TrackListItem, "source">): boolean {
  return isLocalTrack(track) || track.source === "tidal";
}

/** A track whose album lives on the streaming source rather than in the library. */
export function isTidalTrack(track: Pick<TrackListItem, "source">): boolean {
  return track.source === "tidal";
}

/**
 * Which track actions to offer, so the web context menu and the mobile action
 * menu gate them the same way. Each mirrors what the server accepts: editing,
 * moving and both deletes take local track ids only, and editing, moving and
 * the shared-library removal are admin routes. A platform that lacks an
 * action (mobile has no move or admin removal) just ignores its flag.
 */
export interface TrackActions {
  /** False for a track TIDAL dropped with no library copy: nothing to stream. */
  play: boolean;
  download: boolean;
  viewAlbum: boolean;
  share: boolean;
  editMetadata: boolean;
  /** Edit the track's library album (title, artist, cover). */
  editAlbum: boolean;
  moveToAlbum: boolean;
  /** The viewer's own personal upload. */
  deleteOwnUpload: boolean;
  /** Admin hard delete of a shared-library track, for everyone. */
  adminRemove: boolean;
}

export function trackActions(
  track: Pick<TrackListItem, "source" | "unavailable" | "album_id" | "album_title" | "owned">,
  { isAdmin }: { isAdmin: boolean },
): TrackActions {
  const local = isLocalTrack(track);
  const owned = Boolean(track.owned) && local;
  return {
    play: !track.unavailable,
    download: !track.unavailable,
    viewAlbum: Boolean(track.album_id || track.album_title || isTidalTrack(track)),
    share: canShareTrack(track),
    editMetadata: isAdmin && local,
    editAlbum: isAdmin && local && Boolean(track.album_id),
    moveToAlbum: isAdmin && local,
    deleteOwnUpload: owned,
    adminRemove: isAdmin && local && !owned,
  };
}

/** Confirmation for deleting a personal upload; the delete can't be undone. */
export function deleteOwnUploadMessage(track: Pick<TrackListItem, "title">): string {
  return `Delete "${track.title}" from your library? This permanently removes the file you uploaded.`;
}
