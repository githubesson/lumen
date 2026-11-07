//! The Library pages' helpers: `@music-library/core`'s entity labels,
//! artist releases, entity targets and album downloads (ported in
//! [`crate::core`]), and the two the pages keep for themselves.

use crate::api::{TrackListItem, TrackSource};

pub use crate::core::artist_releases::{
    ARTIST_POPULAR_PREVIEW_COUNT, ArtistRelease, RELEASE_FILTER_OPTIONS, ReleaseFilter, filter_releases, fold_release_versions,
    has_release_filters, library_artist_releases, release_subtitle, release_target, release_version_labels, release_versions_of,
    tidal_artist_releases,
};
pub use crate::core::entity_labels::{
    AlbumCredit, AlbumFact, AlbumFactKey as FactKey, CreditsInput as CreditFields, album_credits, artist_meta_parts, artist_subtitle,
    tidal_artist_meta_parts,
};
pub use crate::core::entity_target::{EntityKind, EntityTarget, search_entity_target};
pub use crate::core::track::{ALBUM_DOWNLOAD_REFRESH_MS, AlbumDownloadState, album_download_state};

/// `albumSubtitle`: "Artist · 12 tracks · TIDAL".
pub fn album_subtitle(album: &crate::api::Album, source: Option<TrackSource>) -> String {
    crate::core::entity_labels::album_subtitle(album.artist_name.as_deref(), album.is_compilation, album.track_count, source, true)
}

/// The durations an album's facts add up.
pub fn durations(tracks: &[TrackListItem]) -> Vec<u64> {
    tracks.iter().map(|t| t.duration_ms).collect()
}

/// `trackSearchKey`: what an album or artist page's search matches.
pub fn track_search_key(t: &TrackListItem) -> String {
    let source = t.source.and_then(|s| match s {
        TrackSource::Local => Some("local"),
        TrackSource::Tidal => Some("tidal"),
        TrackSource::Other => None,
    });
    [Some(t.title.as_str()), t.artist.as_deref(), t.album_title.as_deref(), t.aka.as_deref(), source]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

