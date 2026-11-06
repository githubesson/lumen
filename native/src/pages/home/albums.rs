//! `homeAlbums.ts`: the library albums the newest tracks belong to.

use crate::api::TrackListItem;

use super::logic::track_album_target;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HomeAlbum {
    /// The library album id.
    pub id: String,
    pub title: String,
    pub artist: String,
}

/// The library albums `tracks` belong to, each once, in the order their first
/// track appears (Home passes the newest tracks, so the newest albums lead).
///
/// Tracks are grouped by album, not by their artist line: a track with a
/// featured guest is still on the same album. The album's artist is the line
/// most of its tracks carry (the first one seen on a tie). Tracks without a
/// library album are left out, since there would be no album to open or play.
pub fn home_albums(tracks: &[TrackListItem]) -> Vec<HomeAlbum> {
    let mut albums: Vec<(String, String, Vec<(String, usize)>)> = Vec::new();
    for track in tracks {
        let Some(target) = track_album_target(track).filter(|t| t.kind != crate::core::entity_target::EntityKind::Tidal) else { continue };
        let Some(title) = track.album_title.as_deref().map(str::trim).filter(|t| !t.is_empty()) else { continue };
        let at = match albums.iter().position(|(id, _, _)| *id == target.id) {
            Some(i) => i,
            None => {
                albums.push((target.id.clone(), title.to_string(), Vec::new()));
                albums.len() - 1
            }
        };
        let artist = track.artist.as_deref().map(str::trim).filter(|a| !a.is_empty()).unwrap_or("Unknown artist");
        let counts = &mut albums[at].2;
        match counts.iter_mut().find(|(name, _)| name == artist) {
            Some((_, n)) => *n += 1,
            None => counts.push((artist.to_string(), 1)),
        }
    }
    albums
        .into_iter()
        .map(|(id, title, counts)| {
            let mut artist = "Unknown artist".to_string();
            let mut most = 0;
            for (name, count) in counts {
                if count > most {
                    artist = name;
                    most = count;
                }
            }
            HomeAlbum { id, title, artist }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::TrackSource;

    fn track(id: &str, album: Option<&str>, artist: &str) -> TrackListItem {
        TrackListItem {
            id: id.into(),
            title: id.into(),
            duration_ms: 1,
            source: Some(TrackSource::Local),
            album_id: album.map(str::to_string),
            album_title: album.map(|a| format!("Album {a}")),
            artist: Some(artist.into()),
            ..Default::default()
        }
    }

    #[test]
    fn each_album_once_in_order() {
        let albums = home_albums(&[track("1", Some("b"), "Kestrel Bay"), track("2", Some("a"), "Halden Marsh"), track("3", Some("b"), "Kestrel Bay")]);
        assert_eq!(albums.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["b", "a"]);
    }

    #[test]
    fn featured_guest_stays_on_the_album() {
        let albums = home_albums(&[
            track("1", Some("a"), "Halden Marsh, Hana Okoro"),
            track("2", Some("a"), "Halden Marsh"),
            track("3", Some("a"), "Halden Marsh"),
        ]);
        assert_eq!(albums, vec![HomeAlbum { id: "a".into(), title: "Album a".into(), artist: "Halden Marsh".into() }]);
    }

    #[test]
    fn skips_tracks_without_a_library_album() {
        let mut tidal = track("tidal", Some("hidden"), "Kestrel Bay");
        tidal.source = Some(TrackSource::Tidal);
        tidal.source_album_id = Some("77".into());
        let albums = home_albums(&[track("loose", None, "Kestrel Bay"), tidal, track("1", Some("a"), "")]);
        assert_eq!(albums, vec![HomeAlbum { id: "a".into(), title: "Album a".into(), artist: "Unknown artist".into() }]);
    }
}
