//! `core/src/playlist-permissions.ts`: what the signed-in user may do with
//! a playlist, mirroring the server's checks so pages only offer what it
//! accepts. `effective_role` is the server's per-playlist answer; a missing
//! role grants nothing.

use crate::api::{CollaboratorStatus, EffectiveRole, Me, Playlist, Role, Visibility};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct PlaylistPermissions {
    pub role: EffectiveRole,
    pub is_owner: bool,
    /// Add, remove and reorder tracks: the owner and editors.
    pub can_edit_tracks: bool,
    /// Name, description and visibility: the owner only.
    pub can_edit_details: bool,
    pub can_change_cover: bool,
    pub can_delete: bool,
    /// Anyone on a collaborative playlist, and its owner after making it
    /// private, so leftover collaborators can still be removed.
    pub can_see_collaborators: bool,
    /// Change anyone's role or remove anyone: the owner only.
    pub can_manage_collaborators: bool,
    /// The server refuses invites to a private playlist.
    pub can_invite: bool,
    /// Saving its TIDAL tracks to the server library is an admin action.
    pub can_toggle_tidal_auto_download: bool,
}

/// `playlistPermissions` from the playlist's role and visibility (`None`
/// before it has loaded).
pub fn permissions_for(
    effective_role: Option<EffectiveRole>,
    visibility: Option<Visibility>,
    me: Option<&Me>,
) -> PlaylistPermissions {
    let role = effective_role.unwrap_or(EffectiveRole::None);
    let has_access = role != EffectiveRole::None;
    let is_owner = role == EffectiveRole::Owner;
    let collaborative = visibility == Some(Visibility::Collaborative);
    PlaylistPermissions {
        role,
        is_owner,
        can_edit_tracks: is_owner || role == EffectiveRole::Editor,
        can_edit_details: is_owner,
        can_change_cover: is_owner,
        can_delete: is_owner,
        can_see_collaborators: is_owner || (has_access && collaborative),
        can_manage_collaborators: is_owner,
        can_invite: is_owner && collaborative,
        can_toggle_tidal_auto_download: has_access && me.is_some_and(|m| m.role == Role::Admin),
    }
}

/// `playlistPermissions`.
pub fn playlist_permissions(playlist: Option<&Playlist>, me: Option<&Me>) -> PlaylistPermissions {
    permissions_for(playlist.and_then(|p| p.effective_role), playlist.map(|p| p.visibility), me)
}

/// Whether tracks can be added: it has to be yours or you its editor.
pub fn can_add_to_playlist(playlist: &Playlist) -> bool {
    matches!(playlist.effective_role, Some(EffectiveRole::Owner | EffectiveRole::Editor))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct CollaboratorPermissions {
    pub is_self: bool,
    pub can_remove: bool,
    pub can_change_role: bool,
}

/// What the signed-in user may do to one row of the collaborator list: the
/// owner may remove anyone; anyone else only themselves (leaving). Roles
/// change only on accepted collaborators.
pub fn collaborator_permissions(
    permissions: &PlaylistPermissions,
    user_id: &str,
    status: CollaboratorStatus,
    me: Option<&Me>,
) -> CollaboratorPermissions {
    let is_self = me.is_some_and(|m| !m.id.is_empty() && m.id == user_id);
    CollaboratorPermissions {
        is_self,
        can_remove: permissions.can_manage_collaborators || is_self,
        can_change_role: permissions.can_manage_collaborators && status == CollaboratorStatus::Accepted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me(id: &str, role: Role) -> Me {
        Me { id: id.into(), username: id.into(), role, must_reset_password: false }
    }

    fn perms(role: Option<EffectiveRole>, vis: Visibility, who: Option<&Me>) -> PlaylistPermissions {
        permissions_for(role, Some(vis), who)
    }

    const C: Visibility = Visibility::Collaborative;

    #[test]
    fn owner_gets_everything_but_the_admin_switch() {
        let user = me("u1", Role::User);
        assert_eq!(
            perms(Some(EffectiveRole::Owner), C, Some(&user)),
            PlaylistPermissions {
                role: EffectiveRole::Owner,
                is_owner: true,
                can_edit_tracks: true,
                can_edit_details: true,
                can_change_cover: true,
                can_delete: true,
                can_see_collaborators: true,
                can_manage_collaborators: true,
                can_invite: true,
                can_toggle_tidal_auto_download: false,
            }
        );
    }

    #[test]
    fn editors_and_viewers() {
        let user = me("u1", Role::User);
        let p = perms(Some(EffectiveRole::Editor), C, Some(&user));
        assert!(p.can_edit_tracks && p.can_see_collaborators);
        assert!(!p.can_edit_details && !p.can_change_cover && !p.can_delete && !p.can_manage_collaborators && !p.can_invite);
        let p = perms(Some(EffectiveRole::Viewer), C, Some(&user));
        assert!(!p.can_edit_tracks && !p.can_edit_details && p.can_see_collaborators && !p.can_manage_collaborators);
    }

    #[test]
    fn a_missing_role_grants_nothing() {
        let admin = me("u1", Role::Admin);
        for role in [None, Some(EffectiveRole::None)] {
            let p = perms(role, C, Some(&admin));
            assert!(!p.is_owner && !p.can_edit_tracks && !p.can_edit_details && !p.can_delete);
            assert!(!p.can_see_collaborators && !p.can_invite && !p.can_toggle_tidal_auto_download);
        }
        let p = playlist_permissions(None, Some(&admin));
        assert_eq!(p, PlaylistPermissions::default());
        assert_eq!(p.role.as_str(), "");
    }

    #[test]
    fn private_owner_keeps_the_list_without_invites() {
        let p = perms(Some(EffectiveRole::Owner), Visibility::Private, Some(&me("u1", Role::User)));
        assert!(p.can_see_collaborators && p.can_manage_collaborators && !p.can_invite);
    }

    #[test]
    fn admins_with_access_toggle_tidal_saving() {
        let admin = me("u1", Role::Admin);
        assert!(perms(Some(EffectiveRole::Viewer), C, Some(&admin)).can_toggle_tidal_auto_download);
        assert!(perms(Some(EffectiveRole::Owner), C, Some(&admin)).can_toggle_tidal_auto_download);
        assert!(!perms(Some(EffectiveRole::Owner), C, None).can_toggle_tidal_auto_download);
    }

    #[test]
    fn adds_only_to_owned_or_edited_playlists() {
        let p = |role| Playlist { id: "p".into(), name: "n".into(), effective_role: role, ..serde_json::from_str(r#"{"id":"p","name":"n"}"#).unwrap() };
        assert!(can_add_to_playlist(&p(Some(EffectiveRole::Owner))));
        assert!(can_add_to_playlist(&p(Some(EffectiveRole::Editor))));
        assert!(!can_add_to_playlist(&p(Some(EffectiveRole::Viewer))));
        assert!(!can_add_to_playlist(&p(Some(EffectiveRole::None))));
        assert!(!can_add_to_playlist(&p(None)));
    }

    #[test]
    fn collaborator_rows() {
        let user = me("u1", Role::User);
        let u2 = me("u2", Role::User);
        let owner = perms(Some(EffectiveRole::Owner), C, Some(&user));
        let editor = perms(Some(EffectiveRole::Editor), C, Some(&u2));
        use CollaboratorStatus::{Accepted, Pending};
        assert_eq!(
            collaborator_permissions(&owner, "u2", Accepted, Some(&user)),
            CollaboratorPermissions { is_self: false, can_remove: true, can_change_role: true }
        );
        assert!(!collaborator_permissions(&owner, "u3", Pending, Some(&user)).can_change_role);
        assert!(collaborator_permissions(&owner, "u3", Pending, Some(&user)).can_remove);
        assert_eq!(
            collaborator_permissions(&editor, "u2", Accepted, Some(&u2)),
            CollaboratorPermissions { is_self: true, can_remove: true, can_change_role: false }
        );
        assert_eq!(collaborator_permissions(&editor, "u3", Pending, Some(&u2)), CollaboratorPermissions::default());
        assert!(!collaborator_permissions(&editor, "", Accepted, Some(&me("", Role::User))).can_remove);
        assert!(!collaborator_permissions(&editor, "u2", Accepted, None).is_self);
    }
}
