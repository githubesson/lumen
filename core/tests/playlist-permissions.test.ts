import { describe, expect, it } from "vitest";
import type { EffectiveRole, Visibility } from "../src/api";
import {
  canAddToPlaylist,
  collaboratorPermissions,
  playlistPermissions,
} from "../src/playlist-permissions";

const playlist = (
  effective_role: EffectiveRole | undefined,
  visibility: Visibility = "collaborative",
) => ({ effective_role, visibility });

const user = { id: "u1", role: "user" };
const admin = { id: "u1", role: "admin" };

describe("playlistPermissions", () => {
  it("gives the owner everything but the admin-only switch", () => {
    expect(playlistPermissions(playlist("owner"), user)).toEqual({
      role: "owner",
      isOwner: true,
      canEditTracks: true,
      canEditDetails: true,
      canChangeCover: true,
      canDelete: true,
      canSeeCollaborators: true,
      canManageCollaborators: true,
      canInvite: true,
      canToggleTidalAutoDownload: false,
    });
  });

  it("lets an editor change tracks but not the details, cover or collaborators", () => {
    // The server's Update, PutCover and Delete are owner-only.
    const p = playlistPermissions(playlist("editor"), user);
    expect(p.canEditTracks).toBe(true);
    expect(p.canEditDetails).toBe(false);
    expect(p.canChangeCover).toBe(false);
    expect(p.canDelete).toBe(false);
    expect(p.canManageCollaborators).toBe(false);
    expect(p.canInvite).toBe(false);
    expect(p.canSeeCollaborators).toBe(true);
  });

  it("lets a viewer only look", () => {
    const p = playlistPermissions(playlist("viewer"), user);
    expect(p.canEditTracks).toBe(false);
    expect(p.canEditDetails).toBe(false);
    expect(p.canSeeCollaborators).toBe(true);
    expect(p.canManageCollaborators).toBe(false);
  });

  it.each([undefined, "" as const])(
    "grants nothing for a missing or empty role (%j), not ownership",
    (role) => {
      const p = playlistPermissions(playlist(role), admin);
      expect(p.isOwner).toBe(false);
      expect(p.canEditTracks).toBe(false);
      expect(p.canEditDetails).toBe(false);
      expect(p.canDelete).toBe(false);
      expect(p.canSeeCollaborators).toBe(false);
      expect(p.canInvite).toBe(false);
      expect(p.canToggleTidalAutoDownload).toBe(false);
    },
  );

  it("grants nothing before the playlist has loaded", () => {
    const p = playlistPermissions(null, admin);
    expect(p.role).toBe("");
    expect(Object.entries(p).filter(([, v]) => v === true)).toEqual([]);
  });

  it("keeps the collaborator list open to the owner of a private playlist, without invites", () => {
    // Invites to a private playlist are refused (400), but leftover
    // collaborators can still be removed or have their role changed.
    const p = playlistPermissions(playlist("owner", "private"), user);
    expect(p.canSeeCollaborators).toBe(true);
    expect(p.canManageCollaborators).toBe(true);
    expect(p.canInvite).toBe(false);
  });

  it("offers the TIDAL server-save switch to admins with access, whatever their role", () => {
    expect(playlistPermissions(playlist("viewer"), admin).canToggleTidalAutoDownload).toBe(true);
    expect(playlistPermissions(playlist("owner"), admin).canToggleTidalAutoDownload).toBe(true);
    expect(playlistPermissions(playlist("owner"), null).canToggleTidalAutoDownload).toBe(false);
  });
});

describe("canAddToPlaylist", () => {
  it("accepts playlists you own or edit, and nothing else", () => {
    expect(canAddToPlaylist({ effective_role: "owner" })).toBe(true);
    expect(canAddToPlaylist({ effective_role: "editor" })).toBe(true);
    expect(canAddToPlaylist({ effective_role: "viewer" })).toBe(false);
    expect(canAddToPlaylist({ effective_role: "" })).toBe(false);
    expect(canAddToPlaylist({})).toBe(false);
  });
});

describe("collaboratorPermissions", () => {
  const owner = playlistPermissions(playlist("owner"), user);
  const editor = playlistPermissions(playlist("editor"), { id: "u2" });
  const accepted = { user_id: "u2", status: "accepted" as const };
  const pending = { user_id: "u3", status: "pending" as const };

  it("lets the owner remove anyone and change accepted collaborators' roles", () => {
    expect(collaboratorPermissions(owner, accepted, user)).toEqual({
      isSelf: false,
      canRemove: true,
      canChangeRole: true,
    });
    // The server only updates the role of an accepted collaborator.
    expect(collaboratorPermissions(owner, pending, user).canChangeRole).toBe(false);
    expect(collaboratorPermissions(owner, pending, user).canRemove).toBe(true);
  });

  it("lets anyone else remove only themselves", () => {
    expect(collaboratorPermissions(editor, accepted, { id: "u2" })).toEqual({
      isSelf: true,
      canRemove: true,
      canChangeRole: false,
    });
    expect(collaboratorPermissions(editor, pending, { id: "u2" })).toEqual({
      isSelf: false,
      canRemove: false,
      canChangeRole: false,
    });
  });

  it("doesn't take an unknown user for the collaborator", () => {
    expect(collaboratorPermissions(editor, { user_id: "", status: "accepted" }, { id: "" }).canRemove).toBe(false);
    expect(collaboratorPermissions(editor, accepted, null).isSelf).toBe(false);
  });
});
