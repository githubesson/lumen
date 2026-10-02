/**
 * What the signed-in user may do with a playlist, mirroring the checks in
 * `backend/internal/httpapi/handlers/playlists.go` so the clients only offer
 * actions the server accepts.
 *
 * `effective_role` is the server's per-playlist answer: "owner", "editor",
 * "viewer", or "" for no access. A missing role grants nothing. Reading it as
 * "owner" (as the phone once did) offered edits the server then refused.
 */

import type { Collaborator, EffectiveRole, Playlist } from "./api";

/** The playlist fields the rules read. */
export type PlaylistAccess = Pick<Playlist, "effective_role" | "visibility">;

/** The signed-in user, as far as the rules care. */
export type PlaylistViewer = { id?: string; role?: string } | null | undefined;

export interface PlaylistPermissions {
  role: EffectiveRole;
  isOwner: boolean;
  /** Add, remove and reorder tracks: the owner and editors. */
  canEditTracks: boolean;
  /** Name, description and visibility: the owner only. */
  canEditDetails: boolean;
  canChangeCover: boolean;
  canDelete: boolean;
  /**
   * The collaborator list: anyone on a collaborative playlist, and its owner
   * after making it private, so leftover collaborators can still be removed.
   */
  canSeeCollaborators: boolean;
  /** Change anyone's role or remove anyone: the owner only. */
  canManageCollaborators: boolean;
  /** The server refuses invites to a private playlist. */
  canInvite: boolean;
  /** Saving its TIDAL tracks to the server library is an admin action. */
  canToggleTidalAutoDownload: boolean;
}

export function playlistPermissions(
  playlist: PlaylistAccess | null | undefined,
  me: PlaylistViewer,
): PlaylistPermissions {
  const role: EffectiveRole = playlist?.effective_role ?? "";
  const hasAccess = role !== "";
  const isOwner = role === "owner";
  const collaborative = playlist?.visibility === "collaborative";
  return {
    role,
    isOwner,
    canEditTracks: isOwner || role === "editor",
    canEditDetails: isOwner,
    canChangeCover: isOwner,
    canDelete: isOwner,
    canSeeCollaborators: isOwner || (hasAccess && collaborative),
    canManageCollaborators: isOwner,
    canInvite: isOwner && collaborative,
    canToggleTidalAutoDownload: hasAccess && me?.role === "admin",
  };
}

/** Whether tracks can be added to `playlist`: it has to be yours or you its editor. */
export function canAddToPlaylist(playlist: Pick<Playlist, "effective_role">): boolean {
  return playlist.effective_role === "owner" || playlist.effective_role === "editor";
}

/**
 * What the signed-in user may do to one row of the collaborator list. The
 * owner may remove anyone; anyone else only themselves (leaving the
 * playlist). Roles change only on accepted collaborators.
 */
export function collaboratorPermissions(
  permissions: Pick<PlaylistPermissions, "canManageCollaborators">,
  collaborator: Pick<Collaborator, "user_id" | "status">,
  me: PlaylistViewer,
): { isSelf: boolean; canRemove: boolean; canChangeRole: boolean } {
  const isSelf = !!me?.id && me.id === collaborator.user_id;
  return {
    isSelf,
    canRemove: permissions.canManageCollaborators || isSelf,
    canChangeRole:
      permissions.canManageCollaborators && collaborator.status === "accepted",
  };
}
