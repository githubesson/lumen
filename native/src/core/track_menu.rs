//! The pure parts of the web's `lib/trackMenu.ts`: batching playlist adds,
//! and what a selection of tracks shows and toggles.

use std::collections::HashSet;

use crate::api::TrackListItem;
use crate::format::clean_text;

/// The server takes at most this many track ids per add-to-playlist request.
pub const PLAYLIST_ADD_BATCH: usize = 1000;

/// `addBatches`: `ids` cut into requests the server accepts.
pub fn add_batches(ids: &[String], size: usize) -> Vec<Vec<String>> {
    ids.chunks(size.max(1)).map(<[String]>::to_vec).collect()
}

/// `uniqueTracks`: each track once, in list order.
pub fn unique_tracks<T: Clone>(tracks: &[T], id: impl Fn(&T) -> &str) -> Vec<T> {
    let mut seen = HashSet::new();
    tracks.iter().filter(|t| seen.insert(id(t).to_string())).cloned().collect()
}

/// `selectionCovers`: the tracks whose covers stack up for a selection, one
/// per album first so the stack shows as many covers as it can.
pub fn selection_covers(tracks: &[TrackListItem], max: usize) -> Vec<TrackListItem> {
    let count = max.min(tracks.len());
    let mut seen = HashSet::new();
    let mut picked = std::collections::BTreeSet::new();
    for (i, t) in tracks.iter().enumerate() {
        let key = t.album_id.clone().or_else(|| t.cover_url.clone()).or_else(|| t.album_title.clone()).unwrap_or_else(|| t.id.clone());
        if picked.len() < count && seen.insert(key) {
            picked.insert(i);
        }
    }
    let mut i = 0;
    while picked.len() < count {
        picked.insert(i);
        i += 1;
    }
    picked.into_iter().map(|i| tracks[i].clone()).collect()
}

/// `selectionArtists`: a selection's artists, each once, in list order.
pub fn selection_artists(tracks: &[TrackListItem]) -> String {
    let mut names: Vec<String> = Vec::new();
    for t in tracks {
        let name = clean_text(t.artist.as_deref());
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names.join(", ")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FavoriteState {
    All,
    Some,
    None,
}

/// `favoriteState`: whether all, some, or none of `ids` are favorites.
pub fn favorite_state<'a>(ids: impl IntoIterator<Item = &'a str>, is_favorite: impl Fn(&str) -> bool) -> FavoriteState {
    let (mut total, mut count) = (0, 0);
    for id in ids {
        total += 1;
        if is_favorite(id) {
            count += 1;
        }
    }
    if count == 0 {
        FavoriteState::None
    } else if count == total {
        FavoriteState::All
    } else {
        FavoriteState::Some
    }
}

/// `favoriteToggleIds`: every favorite when all of them are (removing
/// them), else the ones not yet favorited (adding those).
pub fn favorite_toggle_ids(ids: &[&str], is_favorite: impl Fn(&str) -> bool) -> Vec<String> {
    let all = favorite_state(ids.iter().copied(), &is_favorite) == FavoriteState::All;
    ids.iter().filter(|id| is_favorite(id) == all).map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str, album: Option<&str>, artist: Option<&str>) -> TrackListItem {
        TrackListItem {
            id: id.into(),
            title: id.into(),
            duration_ms: 1,
            album_id: album.map(Into::into),
            artist: artist.map(Into::into),
            ..Default::default()
        }
    }

    fn ids(v: Vec<TrackListItem>) -> Vec<String> {
        v.into_iter().map(|t| t.id).collect()
    }

    // track-menu.test.ts
    #[test]
    fn batches() {
        let s = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(add_batches(&s(&["a", "b", "c", "d", "e"]), 2), [s(&["a", "b"]), s(&["c", "d"]), s(&["e"])]);
        assert!(add_batches(&[], 2).is_empty());
    }

    #[test]
    fn covers_and_artists() {
        let tracks = [
            t("1", Some("x"), Some("Ada")),
            t("2", Some("x"), Some("Ada")),
            t("3", Some("y"), Some("Ben")),
            t("4", None, Some("")),
            t("5", Some("z"), Some("Cy")),
        ];
        assert_eq!(ids(selection_covers(&tracks, 3)), ["1", "3", "4"]);
        assert_eq!(selection_artists(&tracks), "Ada, Ben, Cy");
        let one_album: Vec<TrackListItem> = ["1", "2", "3", "4"].iter().map(|i| t(i, Some("x"), None)).collect();
        assert_eq!(ids(selection_covers(&one_album, 3)), ["1", "2", "3"]);
        let two = [t("1", Some("x"), None), t("2", Some("x"), None), t("3", Some("y"), None)];
        assert_eq!(ids(selection_covers(&two, 3)), ["1", "2", "3"]);
        assert_eq!(ids(selection_covers(&two[..2], 3)), ["1", "2"]);
    }

    #[test]
    fn favorite_toggles() {
        let all = ["a", "b", "c"];
        assert_eq!(favorite_toggle_ids(&all, |id| id == "b"), ["a", "c"]);
        assert_eq!(favorite_toggle_ids(&all, |_| false), ["a", "b", "c"]);
        assert_eq!(favorite_toggle_ids(&all, |_| true), ["a", "b", "c"]);
        assert_eq!(favorite_state(all, |id| id == "a"), FavoriteState::Some);
    }

    #[test]
    fn unique() {
        let v = [t("a", None, None), t("b", None, None), t("a", None, None)];
        assert_eq!(ids(unique_tracks(&v, |t| t.id.as_str())), ["a", "b"]);
    }
}
