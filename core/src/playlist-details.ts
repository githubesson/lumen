/**
 * A playlist's editable details (name, description, visibility) and its
 * cover, as the create and edit forms on both clients send them.
 *
 * The server trims the name and answers 400 when nothing is left, and stores
 * the description as sent. Both fields are trimmed here, so a trailing space
 * never becomes part of a description or a pending edit, and a blank name is
 * caught before the request.
 */

import type { Playlist, Visibility } from "./api";

export interface PlaylistDetailsDraft {
  name: string;
  description?: string | null;
  visibility: Visibility;
}

/** The body `createPlaylist` and `updatePlaylist` take. */
export interface PlaylistDetailsPayload {
  name: string;
  description: string;
  visibility: Visibility;
}

export function playlistDetailsPayload(
  draft: PlaylistDetailsDraft,
): PlaylistDetailsPayload {
  return {
    name: draft.name.trim(),
    description: (draft.description ?? "").trim(),
    visibility: draft.visibility,
  };
}

/** The server's rule: a name with something besides whitespace. */
export function isValidPlaylistName(name: string): boolean {
  return name.trim().length > 0;
}

/** Whether two drafts would save the same details. */
export function samePlaylistDetails(
  a: PlaylistDetailsDraft,
  b: PlaylistDetailsDraft,
): boolean {
  const x = playlistDetailsPayload(a);
  const y = playlistDetailsPayload(b);
  return (
    x.name === y.name &&
    x.description === y.description &&
    x.visibility === y.visibility
  );
}

/** The server's cap on a cover upload; checked first to skip a doomed upload. */
export const PLAYLIST_COVER_MAX_BYTES = 16 << 20;

/**
 * The message for a cover image over the server's cap, or null when it fits.
 * An unknown size passes: the server still enforces the cap.
 */
export function playlistCoverSizeError(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  return bytes > PLAYLIST_COVER_MAX_BYTES
    ? "That image is over 16 MB. Choose a smaller one."
    : null;
}

/**
 * The line under a playlist's name in lists and pickers: its visibility, then
 * your role on it when it isn't yours ("Collaborative · editor").
 */
export function playlistSubtitle(
  playlist: Pick<Playlist, "visibility" | "effective_role">,
): string {
  const visibility =
    playlist.visibility === "collaborative" ? "Collaborative" : "Private";
  const role = playlist.effective_role;
  return role && role !== "owner" ? `${visibility} · ${role}` : visibility;
}
