//! The helpers Home takes from `@music-library/core` (`replay/period.ts`,
//! `replay/replay.ts`, `track.ts`, `entity-target.ts`,
//! `playlist-details.ts`, `format.ts`), ported in [`crate::core`] and
//! [`crate::format`], under the names Home's panels use.

use crate::api::stats::{ReplayAlbum, ReplayArtist, ReplayData, ReplayTrack};
use crate::api::TrackListItem;
use crate::core::dates::now_ms;
use crate::core::replay::{figures, period};

pub use crate::api::error_message;
pub use crate::core::entity_target::{EntityTarget, replay_album_target};
pub use crate::core::replay::figures::{ReplayCalendar, TopArtistAction, activity_series, genre_shares, plays_by_id};
pub use crate::core::replay::period::{Period, ReplayRange};
pub use crate::core::track::playable_tracks;
pub use crate::format::{group_thousands as locale_int, pluralize, pluralize_grouped as pluralize_locale};

/// `buildPeriodOptions`: the evergreen windows first, then any past years
/// the server has plays for, then "All time".
pub fn build_period_options(years: &[i32]) -> Vec<Period> {
    period::build_period_options(years, period::current_year(now_ms()))
}

/// `periodRange`, now.
pub fn period_range(p: Period) -> ReplayRange {
    period::period_range(p, now_ms())
}

/// `formatListeningTime(ms, "verbose")`.
pub fn format_listening_time(ms: u64) -> String {
    period::format_listening_time(ms as i64, period::ListeningTimeStyle::Verbose)
}

/// `replayCalendar` over a Replay response.
pub fn replay_calendar(data: &ReplayData, range: &ReplayRange, now_ms: i64) -> Option<ReplayCalendar> {
    figures::replay_calendar(&data.activity, data.bucket, range, now_ms)
}

/// `tracksByArtist`: the top tracks crediting `artist`.
pub fn tracks_by_artist(artist: &ReplayArtist, tracks: &[ReplayTrack]) -> Vec<ReplayTrack> {
    figures::tracks_by_artist(Some(&artist.id), &artist.name, tracks)
}

/// `topArtistAction`.
pub fn top_artist_action(artist: &ReplayArtist, tracks: &[TrackListItem]) -> Option<TopArtistAction> {
    figures::top_artist_action(artist.has_page, tracks)
}

/// `replayAlbumSubtitle`: "Artist · 1,234 plays".
pub fn replay_album_subtitle(album: &ReplayAlbum) -> String {
    figures::replay_album_subtitle(album.artist.as_deref(), album.plays)
}

/// `artistImageUrl`: the first of their tracks with a cover.
pub fn artist_image_url(tracks: &[TrackListItem], size: u32) -> Option<String> {
    crate::api::media::artist_image(None, tracks, Some(size))
}

/// `Intl.ListFormat(undefined, { type: "conjunction" })` in en-US.
pub fn list_format(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [a] => a.clone(),
        [a, b] => format!("{a} and {b}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn periods_round_trip() {
        for p in [Period::All, Period::ThisYear, Period::Year(2024), Period::ThisMonth, Period::Last30] {
            assert_eq!(Period::parse(&p.key()), Some(p));
        }
        assert_eq!(Period::parse("year:24"), None);
        assert_eq!(Period::parse("yesterday"), None);
        assert_eq!(Period::Year(2024).label(), "2024");
    }

    #[test]
    fn listening_time() {
        assert_eq!(format_listening_time(0), "0 min");
        assert_eq!(format_listening_time(45 * 60_000), "45 min");
        assert_eq!(format_listening_time(3 * 3_600_000 + 12 * 60_000), "3h 12m");
        assert_eq!(format_listening_time(26 * 3_600_000), "1d 2h");
        assert_eq!(format_listening_time(48 * 3_600_000), "2 days");
    }

    #[test]
    fn numbers_and_lists() {
        assert_eq!(locale_int(1234567), "1,234,567");
        assert_eq!(locale_int(999), "999");
        assert_eq!(pluralize_locale(1, "play"), "1 play");
        assert_eq!(list_format(&["A".into(), "B".into(), "C".into()]), "A, B, and C");
        assert_eq!(crate::format::clean_text(Some("  Rock Â· Pop ")), "Rock · Pop");
    }
}
