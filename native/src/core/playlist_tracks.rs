//! `core/src/playlist-tracks.ts`: optimistic track-list edits for the
//! playlist page, and the auto-download polling it derives from the list.
//!
//! Removal is addressed by `position`, so an optimistic list carries the
//! positions the server will have given the remaining rows. Positions can
//! have gaps: the server numbers rows it leaves out of what it sends
//! (other users' personal uploads, deleted tracks).

use crate::api::{PlaylistTrackEntry, PlaylistTracks, TrackSource};
use crate::core::dates;

/// While TIDAL tracks are queued, refetch so rows flip to their library copies.
pub const PLAYLIST_AUTO_DOWNLOAD_REFRESH_MS: u64 = 20_000;

/// A row with a playlist position.
pub trait Positioned: Clone {
    fn position(&self) -> u32;
    fn set_position(&mut self, position: u32);
}

impl Positioned for PlaylistTrackEntry {
    fn position(&self) -> u32 {
        self.position
    }
    fn set_position(&mut self, position: u32) {
        self.position = position;
    }
}

/// `playlistTidalQueued`: entries auto-download is saving, as the server
/// counts them (failed downloads waiting out a backoff left out); servers
/// without `tidal_queued` fall back to the rows still on TIDAL.
pub fn playlist_tidal_queued(data: Option<&PlaylistTracks>) -> u32 {
    let Some(d) = data else { return 0 };
    d.tidal_queued.unwrap_or_else(|| d.tracks.iter().filter(|t| t.source == Some(TrackSource::Tidal)).count() as u32)
}

/// `playlistAutoDownloadRefetchMs`: every 20 s while entries are queued,
/// otherwise once the next failed download's retry is due (never sooner
/// than 20 s), otherwise not at all (`None`).
pub fn playlist_auto_download_refetch_ms(data: Option<&PlaylistTracks>, now_ms: i64) -> Option<u64> {
    if playlist_tidal_queued(data) > 0 {
        return Some(PLAYLIST_AUTO_DOWNLOAD_REFRESH_MS);
    }
    let retry_at = dates::parse(data?.tidal_retry_at.as_deref()?)?;
    Some(((retry_at - now_ms).max(0) as u64).max(PLAYLIST_AUTO_DOWNLOAD_REFRESH_MS))
}

/// `removePlaylistEntry`: the list after removing the row at `position`;
/// every later row moves up one, like the server. Unchanged when no row has
/// that position (the server answers 404).
pub fn remove_playlist_entry<T: Positioned>(entries: &[T], position: u32) -> Vec<T> {
    if !entries.iter().any(|e| e.position() == position) {
        return entries.to_vec();
    }
    entries
        .iter()
        .filter(|e| e.position() != position)
        .map(|e| {
            let mut e = e.clone();
            if e.position() > position {
                e.set_position(e.position() - 1);
            }
            e
        })
        .collect()
}

/// `movePlaylistEntry`: the list after dragging the row at index `from` to
/// index `to`; the rows go back into the same set of slots.
pub fn move_playlist_entry<T: Positioned>(entries: &[T], from: usize, to: usize) -> Vec<T> {
    if from == to || from >= entries.len() || to >= entries.len() {
        return entries.to_vec();
    }
    let mut moved = entries.to_vec();
    let entry = moved.remove(from);
    moved.insert(to, entry);
    let mut slots: Vec<u32> = entries.iter().map(Positioned::position).collect();
    slots.sort_unstable();
    for (e, slot) in moved.iter_mut().zip(slots) {
        e.set_position(slot);
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    struct Row {
        position: u32,
        id: String,
    }
    impl Positioned for Row {
        fn position(&self) -> u32 {
            self.position
        }
        fn set_position(&mut self, p: u32) {
            self.position = p;
        }
    }

    fn rows(positions: &[u32]) -> Vec<Row> {
        positions.iter().map(|&p| Row { position: p, id: format!("p{p}") }).collect()
    }

    fn pairs(rows: &[Row]) -> Vec<(&str, u32)> {
        rows.iter().map(|r| (r.id.as_str(), r.position)).collect()
    }

    #[test]
    fn removal_moves_later_rows_up() {
        assert_eq!(pairs(&remove_playlist_entry(&rows(&[0, 1, 2, 3]), 1)), [("p0", 0), ("p2", 1), ("p3", 2)]);
    }

    #[test]
    fn removal_keeps_hidden_gaps() {
        let next = remove_playlist_entry(&rows(&[0, 2, 3]), 0);
        assert_eq!(pairs(&next), [("p2", 1), ("p3", 2)]);
        assert_eq!(pairs(&remove_playlist_entry(&next, 1)), [("p3", 1)]);
        let before = rows(&[0, 1, 2]);
        let after = remove_playlist_entry(&before, 2);
        assert_eq!(after[..], before[..2]);
        assert_eq!(remove_playlist_entry(&rows(&[0, 2]), 1), rows(&[0, 2]));
    }

    #[test]
    fn moves_into_the_same_slots() {
        assert_eq!(pairs(&move_playlist_entry(&rows(&[0, 1, 2]), 0, 2)), [("p1", 0), ("p2", 1), ("p0", 2)]);
        assert_eq!(pairs(&move_playlist_entry(&rows(&[0, 2, 5]), 2, 0)), [("p5", 0), ("p0", 2), ("p2", 5)]);
        let before = rows(&[0, 1]);
        assert_eq!(move_playlist_entry(&before, 1, 1), before);
        assert_eq!(move_playlist_entry(&before, 0, 2), before);
        assert_eq!(PLAYLIST_AUTO_DOWNLOAD_REFRESH_MS, 20_000);
    }

    fn data(sources: &[Option<TrackSource>], queued: Option<u32>, retry: Option<&str>) -> PlaylistTracks {
        PlaylistTracks {
            tracks: sources
                .iter()
                .map(|s| PlaylistTrackEntry { source: *s, ..serde_json::from_str(r#"{"position":0,"track_id":"t","title":"x"}"#).unwrap() })
                .collect(),
            tidal_queued: queued,
            tidal_retry_at: retry.map(Into::into),
        }
    }

    const T: Option<TrackSource> = Some(TrackSource::Tidal);

    #[test]
    fn queued_counts() {
        assert_eq!(playlist_tidal_queued(Some(&data(&[T, T], Some(1), None))), 1);
        assert_eq!(playlist_tidal_queued(Some(&data(&[T, T], Some(0), None))), 0);
        assert_eq!(playlist_tidal_queued(Some(&data(&[T, T], None, None))), 2);
        assert_eq!(playlist_tidal_queued(Some(&data(&[T, Some(TrackSource::Local), None, T], None, None))), 2);
        assert_eq!(playlist_tidal_queued(Some(&data(&[], None, None))), 0);
        assert_eq!(playlist_tidal_queued(None), 0);
    }

    #[test]
    fn refetch_timing() {
        let now = dates::parse("2026-10-02T12:00:00Z").unwrap();
        assert_eq!(playlist_auto_download_refetch_ms(Some(&data(&[], Some(3), None)), now), Some(20_000));
        assert_eq!(
            playlist_auto_download_refetch_ms(Some(&data(&[], Some(0), Some("2026-10-02T13:00:00Z"))), now),
            Some(3_600_000)
        );
        assert_eq!(
            playlist_auto_download_refetch_ms(Some(&data(&[], Some(0), Some("2026-10-02T11:59:59Z"))), now),
            Some(20_000)
        );
        assert_eq!(playlist_auto_download_refetch_ms(Some(&data(&[], Some(0), None)), now), None);
        assert_eq!(playlist_auto_download_refetch_ms(None, now), None);
    }
}
