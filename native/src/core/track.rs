//! `core/src/track.ts` (and the web's `lib/track.ts`): predicates over a
//! track's source, the actions a track offers, album downloads, and the
//! credit helpers of `api-media.ts` (`displayArtists`, `trackCredits`,
//! `primaryArtistName`).
//!
//! [`TrackRef`] is what the web's `Pick<TrackListItem, …>` parameters are:
//! the fields these rules read, from any row type.

use crate::api::{PlaylistTrackEntry, TrackArtist, TrackDetail, TrackListItem, TrackSource};

/// A track-like row: list items, details and playlist entries.
pub trait TrackRef {
    fn track_source(&self) -> Option<TrackSource>;
    fn track_album_id(&self) -> Option<&str>;
    fn track_album_title(&self) -> Option<&str>;
    fn track_source_album_id(&self) -> Option<&str>;
    fn track_owned(&self) -> bool {
        false
    }
    fn track_unavailable(&self) -> bool {
        false
    }
}

impl TrackRef for TrackListItem {
    fn track_source(&self) -> Option<TrackSource> {
        self.source
    }
    fn track_album_id(&self) -> Option<&str> {
        self.album_id.as_deref()
    }
    fn track_album_title(&self) -> Option<&str> {
        self.album_title.as_deref()
    }
    fn track_source_album_id(&self) -> Option<&str> {
        self.source_album_id.as_deref()
    }
    fn track_owned(&self) -> bool {
        self.owned == Some(true)
    }
    fn track_unavailable(&self) -> bool {
        self.unavailable == Some(true)
    }
}

impl TrackRef for TrackDetail {
    fn track_source(&self) -> Option<TrackSource> {
        Some(self.source)
    }
    fn track_album_id(&self) -> Option<&str> {
        self.album_id.as_deref()
    }
    fn track_album_title(&self) -> Option<&str> {
        self.album_title.as_deref()
    }
    fn track_source_album_id(&self) -> Option<&str> {
        self.source_album_id.as_deref()
    }
    fn track_owned(&self) -> bool {
        self.owned == Some(true)
    }
    fn track_unavailable(&self) -> bool {
        self.unavailable == Some(true)
    }
}

impl TrackRef for PlaylistTrackEntry {
    fn track_source(&self) -> Option<TrackSource> {
        self.source
    }
    fn track_album_id(&self) -> Option<&str> {
        self.album_id.as_deref()
    }
    fn track_album_title(&self) -> Option<&str> {
        self.album_title.as_deref()
    }
    fn track_source_album_id(&self) -> Option<&str> {
        self.source_album_id.as_deref()
    }
}

/// `playableTracks`: the tracks of a list that can actually be played.
pub fn playable_tracks<T: TrackRef + Clone>(tracks: &[T]) -> Vec<T> {
    tracks.iter().filter(|t| !t.track_unavailable()).cloned().collect()
}

/// TIDAL tracks of an album listing that aren't in the library and can still
/// be downloaded: what an album download would queue.
pub fn downloadable_album_tracks(tracks: &[TrackListItem]) -> Vec<TrackListItem> {
    tracks.iter().filter(|t| is_tidal_track(*t) && !t.track_unavailable()).cloned().collect()
}

/// How often album pages refetch while tracks are queued for download.
pub const ALBUM_DOWNLOAD_REFRESH_MS: u64 = 15_000;

/// What an admin's album download control offers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AlbumDownloadState {
    Queued { queued: u32, label: String },
    Available { remaining: usize, any_saved: bool, label: String },
    None,
}

/// Progress while tracks are queued, else the whole album when nothing is
/// saved yet or the tracks still missing, else nothing.
pub fn album_download_state(tracks: &[TrackListItem], queued_count: u32) -> AlbumDownloadState {
    if queued_count > 0 {
        return AlbumDownloadState::Queued { queued: queued_count, label: format!("Downloading · {queued_count} left") };
    }
    let remaining = downloadable_album_tracks(tracks).len();
    if remaining == 0 {
        return AlbumDownloadState::None;
    }
    let any_saved = tracks.iter().any(|t| !is_tidal_track(t));
    let label = if any_saved { format!("Download {remaining} remaining") } else { "Download album".into() };
    AlbumDownloadState::Available { remaining, any_saved, label }
}

/// A track stored in this library (no source, or local). Only these can be
/// edited, moved between albums, or exported as files.
pub fn is_local_track(track: &impl TrackRef) -> bool {
    matches!(track.track_source(), None | Some(TrackSource::Local))
}

/// A track whose album lives on TIDAL rather than in the library.
pub fn is_tidal_track(track: &impl TrackRef) -> bool {
    track.track_source() == Some(TrackSource::Tidal)
}

/// Snippet share links work for shared-library and TIDAL tracks; a
/// personal upload is its owner's private file, and an unknown source has
/// nothing the server can share.
pub fn can_share_track(track: &impl TrackRef) -> bool {
    if track.track_owned() {
        return false;
    }
    is_local_track(track) || is_tidal_track(track)
}

/// Which track actions to offer (the context menu's gates).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct TrackActions {
    /// False for a track TIDAL dropped with no library copy.
    pub play: bool,
    pub download: bool,
    pub view_album: bool,
    pub share: bool,
    pub edit_metadata: bool,
    /// Edit the track's library album (title, artist, cover).
    pub edit_album: bool,
    pub move_to_album: bool,
    /// The viewer's own personal upload.
    pub delete_own_upload: bool,
    /// Admin hard delete of a shared-library track, for everyone.
    pub admin_remove: bool,
}

pub fn track_actions(track: &impl TrackRef, is_admin: bool) -> TrackActions {
    let local = is_local_track(track);
    let owned = track.track_owned() && local;
    let has = |s: Option<&str>| s.is_some_and(|s| !s.is_empty());
    TrackActions {
        play: !track.track_unavailable(),
        download: !track.track_unavailable(),
        view_album: has(track.track_album_id()) || has(track.track_album_title()) || is_tidal_track(track),
        share: can_share_track(track),
        edit_metadata: local && (is_admin || owned),
        edit_album: is_admin && local && has(track.track_album_id()),
        move_to_album: is_admin && local,
        delete_own_upload: owned,
        admin_remove: is_admin && local && !owned,
    }
}

/// `displayArtists`: the credited artists, composers left out.
pub fn display_artists(artists: &[TrackArtist]) -> String {
    artists.iter().filter(|a| a.role != "composer").map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
}

fn credit_names(artists: &[TrackArtist], role: &str) -> String {
    artists.iter().filter(|a| a.role == role).map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
}

/// A label and value row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LabelValue {
    pub label: String,
    pub value: String,
}

/// `trackCredits`: Primary artist, Featured and Producers, "—" when empty.
/// Producers come from the composer tag, else composer-role credits.
pub fn track_credits(artists: &[TrackArtist], composer: Option<&str>) -> [LabelValue; 3] {
    let or_dash = |s: String| if s.is_empty() { "—".to_string() } else { s };
    let producers = match composer.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => c.to_string(),
        None => or_dash(credit_names(artists, "composer")),
    };
    [
        LabelValue { label: "Primary artist".into(), value: or_dash(credit_names(artists, "primary")) },
        LabelValue { label: "Featured".into(), value: or_dash(credit_names(artists, "featured")) },
        LabelValue { label: "Producers".into(), value: producers },
    ]
}

/// `primaryArtistName`: the primary credit, else the first, else `fallback`.
pub fn primary_artist_name(artists: &[TrackArtist], fallback: &str) -> String {
    artists
        .iter()
        .find(|a| a.role == "primary")
        .or_else(|| artists.first())
        .map_or_else(|| fallback.to_string(), |a| a.name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(f: impl FnOnce(&mut TrackListItem)) -> TrackListItem {
        let mut t = TrackListItem {
            id: "t".into(),
            title: "Song".into(),
            duration_ms: 1000,
            source: Some(TrackSource::Local),
            ..Default::default()
        };
        f(&mut t);
        t
    }

    fn tidal(id: &str, unavailable: bool) -> TrackListItem {
        track(|t| {
            t.id = id.into();
            t.source = Some(TrackSource::Tidal);
            t.unavailable = unavailable.then_some(true);
        })
    }

    // track-actions.test.ts
    #[test]
    fn offers_a_listener_the_shared_actions() {
        assert_eq!(
            track_actions(&track(|t| t.album_id = Some("a".into())), false),
            TrackActions { play: true, download: true, view_album: true, share: true, ..Default::default() }
        );
    }

    #[test]
    fn lets_an_admin_edit_move_and_remove() {
        let a = track_actions(&track(|t| t.album_id = Some("a".into())), true);
        assert!(a.edit_metadata && a.edit_album && a.move_to_album && a.admin_remove && !a.delete_own_upload);
        assert!(track_actions(&track(|t| t.source = None), true).edit_metadata);
    }

    #[test]
    fn never_offers_edits_of_a_tidal_track() {
        let a = track_actions(
            &track(|t| {
                t.source = Some(TrackSource::Tidal);
                t.album_id = Some("hidden".into());
                t.source_album_id = Some("1".into());
            }),
            true,
        );
        assert!(!a.edit_metadata && !a.edit_album && !a.move_to_album && !a.admin_remove && !a.delete_own_upload);
        assert!(a.share && a.view_album);
    }

    #[test]
    fn only_edits_an_album_the_track_has() {
        let a = track_actions(&track(|t| t.album_title = Some("Loose".into())), true);
        assert!(!a.edit_album && a.view_album);
        assert!(!track_actions(&track(|_| {}), true).view_album);
    }

    #[test]
    fn deletes_the_viewers_own_upload() {
        let a = track_actions(&track(|t| t.owned = Some(true)), true);
        assert!(a.delete_own_upload && !a.admin_remove && !a.share);
        let own = track_actions(&track(|t| t.owned = Some(true)), false);
        assert!(own.delete_own_upload && own.edit_metadata);
        assert!(!own.edit_album && !own.move_to_album && !own.admin_remove);
        assert!(!track_actions(&track(|_| {}), false).edit_metadata);
    }

    #[test]
    fn cant_play_a_dropped_tidal_track() {
        let a = track_actions(&tidal("t", true), false);
        assert!(!a.play && !a.download && a.view_album);
    }

    #[test]
    fn album_download_states() {
        assert_eq!(
            album_download_state(&[tidal("1", false)], 3),
            AlbumDownloadState::Queued { queued: 3, label: "Downloading · 3 left".into() }
        );
        assert_eq!(
            album_download_state(&[tidal("1", false), tidal("2", false)], 0),
            AlbumDownloadState::Available { remaining: 2, any_saved: false, label: "Download album".into() }
        );
        let tracks = [track(|t| t.id = "1".into()), tidal("2", false), tidal("3", true)];
        let ids: Vec<String> = downloadable_album_tracks(&tracks).into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["2"]);
        assert_eq!(
            album_download_state(&tracks, 0),
            AlbumDownloadState::Available { remaining: 1, any_saved: true, label: "Download 1 remaining".into() }
        );
        assert_eq!(album_download_state(&[track(|t| t.id = "1".into()), tidal("2", true)], 0), AlbumDownloadState::None);
        assert_eq!(album_download_state(&[], 0), AlbumDownloadState::None);
        assert_eq!(ALBUM_DOWNLOAD_REFRESH_MS, 15_000);
    }

    // playlist-entry.test.ts
    #[test]
    fn playlist_entries_keep_artwork_and_streaming_ids() {
        let entry = PlaylistTrackEntry {
            position: 7,
            track_id: "track".into(),
            title: "Song".into(),
            duration_ms: 123_000,
            album_id: Some("album".into()),
            has_cover: Some(true),
            cover_url: Some("/cover".into()),
            source: Some(TrackSource::Tidal),
            source_id: Some("42".into()),
            source_album_id: Some("43".into()),
            added_at: "2026-09-05".into(),
            db_track_id: None,
            album_title: None,
            track_no: None,
            artist: None,
            added_by_id: None,
            added_by: None,
            play_count: None,
        };
        for t in [entry.as_track()] {
            assert_eq!(t.id, "track");
            assert_eq!(t.album_id.as_deref(), Some("album"));
            assert_eq!(t.has_cover, Some(true));
            assert_eq!(t.cover_url.as_deref(), Some("/cover"));
            assert_eq!(t.source, Some(TrackSource::Tidal));
            assert_eq!(t.source_id.as_deref(), Some("42"));
            assert_eq!(t.source_album_id.as_deref(), Some("43"));
        }
        assert_eq!(entry.position, 7);
    }

    // shared-helpers.test.ts: track source predicates
    #[test]
    fn source_predicates() {
        assert!(is_local_track(&track(|t| t.source = None)));
        assert!(is_local_track(&track(|_| {})));
        assert!(!is_local_track(&tidal("t", false)));
        assert!(can_share_track(&track(|_| {})));
        assert!(can_share_track(&tidal("t", false)));
        assert!(can_share_track(&track(|t| t.source = None)));
        assert!(!can_share_track(&track(|t| t.source = Some(TrackSource::Other))));
        assert!(!can_share_track(&track(|t| t.owned = Some(true))));
        assert!(!can_share_track(&track(|t| {
            t.source = None;
            t.owned = Some(true);
        })));
        assert!(can_share_track(&track(|t| t.owned = Some(false))));
        assert!(is_tidal_track(&tidal("t", false)));
        assert!(!is_tidal_track(&track(|t| t.source = None)));
    }

    // shared-helpers.test.ts: primaryArtistName
    #[test]
    fn primary_artist_names() {
        let a = |name: &str, role: &str| TrackArtist { id: name.into(), name: name.into(), role: role.into() };
        assert_eq!(primary_artist_name(&[a("Feat", "featured"), a("Main", "primary")], "Unknown artist"), "Main");
        assert_eq!(primary_artist_name(&[a("Only", "featured")], "Unknown artist"), "Only");
        assert_eq!(primary_artist_name(&[], "Unknown artist"), "Unknown artist");
        assert_eq!(primary_artist_name(&[], ""), "");
        let credits = track_credits(&[a("A", "primary"), a("C", "composer")], None);
        assert_eq!(credits[0].value, "A");
        assert_eq!(credits[1].value, "—");
        assert_eq!(credits[2].value, "C");
        assert_eq!(track_credits(&[], Some("  Tag ")).map(|c| c.value)[2], "Tag");
        assert_eq!(display_artists(&[a("A", "primary"), a("C", "composer"), a("B", "featured")]), "A, B");
    }
}
