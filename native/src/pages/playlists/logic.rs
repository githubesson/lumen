//! The rules the playlist pages follow: `@music-library/core`'s
//! `playlist-permissions.ts`, `playlist-details.ts`, `playlist-tracks.ts`
//! and `track-sort.ts` (ported in [`crate::core`]), under the names the
//! pages use, plus `pages/playlist/trackSort.ts`'s options and search key.

use crate::api::{Collaborator, EffectiveRole, Me, Playlist, PlaylistTrackEntry, Visibility};

pub use crate::api::error_message;
pub use crate::core::dates::now_ms;
pub use crate::core::playlist_details::{
    PlaylistDetails as Details, is_valid_playlist_name as is_valid_name,
    playlist_cover_size_error as cover_size_error, playlist_details_form as details_form,
};
pub use crate::core::playlist_permissions::{CollaboratorPermissions as CollaboratorRow, PlaylistPermissions as Permissions};
pub use crate::core::track_sort::SortKey;
pub use crate::format::fmt_date;

/// `playlistPermissions`: a missing role grants nothing.
pub fn permissions(playlist: Option<&Playlist>, me: Option<&Me>) -> Permissions {
    crate::core::playlist_permissions::playlist_permissions(playlist, me)
}

/// `collaboratorPermissions`: what the user may do to one collaborator row.
pub fn collaborator_permissions(p: &Permissions, c: &Collaborator, me: Option<&Me>) -> CollaboratorRow {
    crate::core::playlist_permissions::collaborator_permissions(p, &c.user_id, c.status, me)
}

/// The role as the header spells it ("editor").
pub fn role_name(role: EffectiveRole) -> &'static str {
    if role == EffectiveRole::None { "" } else { role.as_str() }
}

/// `playlistDetailsPayload`: both text fields trimmed.
pub fn details_payload(name: &str, description: &str, visibility: Visibility) -> Details {
    crate::core::playlist_details::playlist_details_payload(&Details { name: name.into(), description: description.into(), visibility })
}

/// `samePlaylistDetails`.
pub fn same_details(a: &Details, b: &Details) -> bool {
    crate::core::playlist_details::same_playlist_details(a, b)
}

/// `playlistSubtitle`: "Collaborative · editor".
pub fn subtitle(p: &Playlist) -> String {
    crate::core::playlist_details::playlist_subtitle(p.visibility, p.effective_role)
}

pub use crate::core::playlist_tracks::{
    playlist_auto_download_refetch_ms as auto_download_refetch_ms, playlist_tidal_queued as tidal_queued,
};

/// `removePlaylistEntry`: drop the row at `position`, moving later rows up.
pub fn remove_entry(entries: &[PlaylistTrackEntry], position: u32) -> Vec<PlaylistTrackEntry> {
    crate::core::playlist_tracks::remove_playlist_entry(entries, position)
}

/// `movePlaylistEntry`: the row at index `from` dragged to index `to`.
pub fn move_entry(entries: &[PlaylistTrackEntry], from: usize, to: usize) -> Vec<PlaylistTrackEntry> {
    crate::core::playlist_tracks::move_playlist_entry(entries, from, to)
}

/// The sort's `<Select>` value.
pub fn sort_value(k: SortKey) -> &'static str {
    match k {
        SortKey::Custom => "custom",
        SortKey::Title => "title",
        SortKey::Duration => "duration",
        SortKey::Plays => "plays",
    }
}

/// The sort a `<Select>` value names.
pub fn parse_sort(s: &str) -> SortKey {
    match s {
        "title" => SortKey::Title,
        "duration" => SortKey::Duration,
        "plays" => SortKey::Plays,
        _ => SortKey::Custom,
    }
}

/// `SORT_OPTIONS` (`pages/playlist/trackSort.ts`).
pub const SORT_OPTIONS: [(SortKey, &str); 4] =
    [(SortKey::Custom, "Custom order"), (SortKey::Title, "Title"), (SortKey::Duration, "Length"), (SortKey::Plays, "Plays")];

/// `sortForDisplay`, as indices into `items`: the saved order for
/// `custom`, else sorted (titles collated), reversed when descending.
pub fn sort_for_display(items: &[PlaylistTrackEntry], key: SortKey, asc: bool) -> Vec<usize> {
    use crate::core::track_sort::{compare_with_title_keys, sort_title_key};
    let mut order: Vec<usize> = (0..items.len()).collect();
    if key == SortKey::Custom {
        return order;
    }
    let keys: Vec<String> = items.iter().map(|t| sort_title_key(&t.title)).collect();
    order.sort_by(|&i, &j| compare_with_title_keys(&items[i], &items[j], key, &keys[i], &keys[j]));
    if !asc {
        order.reverse();
    }
    order
}

/// `usePlaylistTrackKeys`' search key: title, artist and album, lowercased.
pub fn search_key(t: &PlaylistTrackEntry) -> String {
    format!("{} {} {}", t.title, t.artist.as_deref().unwrap_or(""), t.album_title.as_deref().unwrap_or("")).to_lowercase()
}

/// `pluralize`: "1 track", "9 tracks".
pub fn pluralize(n: usize, word: &str) -> String {
    crate::format::pluralize(n as u64, word)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Role;
    use crate::core::track_sort::{collate, sort_title_key};
    use std::cmp::Ordering;

    fn entry(position: u32, id: &str) -> PlaylistTrackEntry {
        PlaylistTrackEntry {
            position,
            track_id: id.into(),
            db_track_id: None,
            source: None,
            source_id: None,
            source_album_id: None,
            title: id.into(),
            album_id: None,
            album_title: None,
            track_no: None,
            duration_ms: 0,
            artist: None,
            has_cover: None,
            cover_url: None,
            added_by_id: None,
            added_by: None,
            added_at: String::new(),
            play_count: None,
        }
    }

    fn playlist(role: Option<EffectiveRole>, visibility: Visibility) -> Playlist {
        serde_json::from_value(serde_json::json!({"id": "p", "name": "P"})).map(|p: Playlist| Playlist {
            effective_role: role,
            visibility,
            ..p
        })
        .unwrap()
    }

    #[test]
    fn permissions_follow_the_role() {
        let admin = Me { id: "u".into(), username: "u".into(), role: Role::Admin, must_reset_password: false };
        let owner = permissions(Some(&playlist(Some(EffectiveRole::Owner), Visibility::Private)), Some(&admin));
        assert!(owner.can_edit_details && owner.can_see_collaborators && !owner.can_invite);
        assert!(owner.can_toggle_tidal_auto_download);
        let editor = permissions(Some(&playlist(Some(EffectiveRole::Editor), Visibility::Collaborative)), None);
        assert!(editor.can_edit_tracks && editor.can_see_collaborators && !editor.can_edit_details);
        assert!(!editor.can_toggle_tidal_auto_download);
        let none = permissions(Some(&playlist(None, Visibility::Collaborative)), Some(&admin));
        assert_eq!(none, Permissions::default());
    }

    #[test]
    fn removes_and_shifts_positions() {
        let rows = vec![entry(0, "a"), entry(2, "b"), entry(3, "c")];
        let next = remove_entry(&rows, 2);
        assert_eq!(next.iter().map(|e| (e.position, e.track_id.as_str())).collect::<Vec<_>>(), [(0, "a"), (2, "c")]);
        assert_eq!(remove_entry(&rows, 9), rows);
    }

    #[test]
    fn moves_keep_the_slots() {
        let rows = vec![entry(0, "a"), entry(2, "b"), entry(5, "c")];
        let next = move_entry(&rows, 0, 2);
        assert_eq!(next.iter().map(|e| (e.position, e.track_id.as_str())).collect::<Vec<_>>(), [(0, "b"), (2, "c"), (5, "a")]);
    }

    #[test]
    fn sorts_titles_naturally() {
        assert_eq!(sort_title_key("🔥  Song  2"), "Song 2");
        assert_eq!(sort_title_key("🔥"), "🔥");
        assert_eq!(collate("track 10", "Track 9"), Ordering::Greater);
        assert_eq!(collate("Émile", "emile"), Ordering::Equal);
        let mut rows = vec![entry(0, "b"), entry(1, "a"), entry(2, "c")];
        rows[0].duration_ms = 5;
        rows[1].duration_ms = 5;
        rows[2].duration_ms = 1;
        assert_eq!(sort_for_display(&rows, SortKey::Duration, true), [2, 1, 0]);
        assert_eq!(sort_for_display(&rows, SortKey::Title, false), [2, 0, 1]);
    }

    #[test]
    fn formats_dates_and_details() {
        assert_eq!(fmt_date("2026-09-01T20:15:00.000Z"), "Sep 1, 2026");
        assert_eq!(fmt_date("2025-12-01T09:00:00Z"), "Dec 1, 2025");
        assert_eq!(crate::core::dates::parse("1970-01-01T00:00:01+01:00"), Some(1000 - 3_600_000));
        assert!(same_details(&details_payload(" a ", "", Visibility::Private), &details_payload("a", " ", Visibility::Private)));
        assert_eq!(cover_size_error(Some(17 << 20)), Some("That image is over 16 MB. Choose a smaller one."));
        assert_eq!(cover_size_error(None), None);
        assert_eq!(pluralize(1, "track"), "1 track");
    }
}
