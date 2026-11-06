//! `core/src/entity-target.ts`: which page an album or artist link opens:
//! the library's own (`id` is the library id) or TIDAL's (`id` is TIDAL's,
//! without the `tidal:` prefix search results carry).

use crate::api::search::search_entity_id;
use crate::api::stats::ReplayAlbum;
use crate::api::{ApiResult, Client, SearchAlbum, SearchArtist, TrackDetail, TrackListItem, TrackSource};
use crate::core::track::{TrackRef, is_tidal_track};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EntityKind {
    Local,
    Tidal,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct EntityTarget {
    pub kind: EntityKind,
    pub id: String,
}

impl EntityTarget {
    pub fn local(id: &str) -> EntityTarget {
        EntityTarget { kind: EntityKind::Local, id: id.to_string() }
    }
    pub fn tidal(id: &str) -> EntityTarget {
        EntityTarget { kind: EntityKind::Tidal, id: id.to_string() }
    }
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.is_empty())
}

/// `trackAlbumTarget`: the album a track opens, from the row alone; `None`
/// when the row doesn't say. A TIDAL track opens its TIDAL release even
/// when it carries an `album_id`: that is a hidden copy's album, which the
/// library routes don't serve.
pub fn track_album_target(track: &impl TrackRef) -> Option<EntityTarget> {
    if is_tidal_track(track) {
        return non_empty(track.track_source_album_id()).map(EntityTarget::tidal);
    }
    non_empty(track.track_album_id()).map(EntityTarget::local)
}

/// `resolveTrackAlbumTarget`: [`track_album_target`], falling back to the
/// track's detail (from `detail`) when the row lacks the id. `None` when the
/// track has no album; a failed detail read is an error.
pub fn resolve_track_album_target(
    track: &TrackListItem,
    detail: impl FnOnce(&str) -> ApiResult<TrackDetail>,
) -> ApiResult<Option<EntityTarget>> {
    if let Some(target) = track_album_target(track) {
        return Ok(Some(target));
    }
    let d = detail(&track.id)?;
    // The row's source decides when it has one.
    let merged = TrackListItem {
        source: track.source.or(Some(d.source)),
        album_id: non_empty(track.album_id.as_deref()).or(d.album_id.as_deref()).map(Into::into),
        source_album_id: non_empty(track.source_album_id.as_deref()).or(d.source_album_id.as_deref()).map(Into::into),
        ..Default::default()
    };
    Ok(track_album_target(&merged))
}

/// [`resolve_track_album_target`] reading the detail from the server.
pub fn resolve_track_album_target_with(c: &Client, track: &TrackListItem) -> ApiResult<Option<EntityTarget>> {
    resolve_track_album_target(track, |id| crate::api::library::get_track(c, id))
}

/// `replayAlbumTarget`: Replay albums carry a materialized library id even
/// when their plays came from TIDAL; those open the TIDAL release.
pub fn replay_album_target(album: &ReplayAlbum) -> EntityTarget {
    match (album.source, non_empty(album.source_album_id.as_deref())) {
        (Some(TrackSource::Tidal), Some(id)) => EntityTarget::tidal(id),
        _ => EntityTarget::local(&album.id),
    }
}

/// `searchEntityTarget`: the page a search result, artist release, or other
/// album/artist payload opens. A payload without a source is a library one.
pub fn search_entity_target(id: &str, source: Option<TrackSource>, source_id: Option<&str>) -> EntityTarget {
    if source == Some(TrackSource::Tidal) {
        EntityTarget::tidal(&search_entity_id(id, source, source_id))
    } else {
        EntityTarget::local(id)
    }
}

pub fn search_album_target(a: &SearchAlbum) -> EntityTarget {
    search_entity_target(&a.album.id, Some(a.source), a.source_id.as_deref())
}

pub fn search_artist_target(a: &SearchArtist) -> EntityTarget {
    search_entity_target(&a.artist.id, Some(a.source), a.source_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{ApiError, Album};
    use crate::core::artist_releases::{library_artist_releases, release_target, tidal_artist_releases};

    fn row(f: impl FnOnce(&mut TrackListItem)) -> TrackListItem {
        let mut t = TrackListItem { id: "t".into(), title: "Song".into(), ..Default::default() };
        f(&mut t);
        t
    }

    fn detail(f: impl FnOnce(&mut TrackDetail)) -> TrackDetail {
        let mut d: TrackDetail = serde_json::from_str(
            r#"{"id":"t","source":"local","title":"Song","duration_ms":1000,"format":"flac","file_size":1,"artists":[],"has_cover":false,"favorited":false}"#,
        )
        .unwrap();
        f(&mut d);
        d
    }

    #[test]
    fn opens_a_library_tracks_album() {
        let t = row(|t| {
            t.source = Some(TrackSource::Local);
            t.album_id = Some("a1".into());
        });
        assert_eq!(track_album_target(&t), Some(EntityTarget::local("a1")));
        assert_eq!(track_album_target(&row(|t| t.album_id = Some("a1".into()))), Some(EntityTarget::local("a1")));
    }

    #[test]
    fn opens_a_tidal_tracks_release() {
        let t = row(|t| {
            t.source = Some(TrackSource::Tidal);
            t.album_id = Some("hidden".into());
            t.source_album_id = Some("123".into());
        });
        assert_eq!(track_album_target(&t), Some(EntityTarget::tidal("123")));
    }

    #[test]
    fn doesnt_know_without_the_id_the_source_needs() {
        let tidal = row(|t| {
            t.source = Some(TrackSource::Tidal);
            t.album_id = Some("hidden".into());
        });
        assert_eq!(track_album_target(&tidal), None);
        let local = row(|t| {
            t.source = Some(TrackSource::Local);
            t.source_album_id = Some("123".into());
        });
        assert_eq!(track_album_target(&local), None);
        assert_eq!(track_album_target(&row(|t| t.source = Some(TrackSource::Local))), None);
    }

    #[test]
    fn answers_from_the_row_without_a_request() {
        let t = row(|t| {
            t.source = Some(TrackSource::Local);
            t.album_id = Some("a1".into());
        });
        let got = resolve_track_album_target(&t, |_| panic!("no request")).unwrap();
        assert_eq!(got, Some(EntityTarget::local("a1")));
    }

    #[test]
    fn falls_back_to_the_detail() {
        let t = row(|t| {
            t.id = "tidal:9".into();
            t.source = Some(TrackSource::Tidal);
            t.album_id = Some("hidden".into());
        });
        let mut asked = String::new();
        let got = resolve_track_album_target(&t, |id| {
            asked = id.to_string();
            Ok(detail(|d| {
                d.source = TrackSource::Tidal;
                d.album_id = Some("hidden".into());
                d.source_album_id = Some("123".into());
            }))
        })
        .unwrap();
        assert_eq!(got, Some(EntityTarget::tidal("123")));
        assert_eq!(asked, "tidal:9");
        let local = row(|t| t.source = Some(TrackSource::Local));
        let got = resolve_track_album_target(&local, |_| Ok(detail(|d| d.album_id = Some("a2".into())))).unwrap();
        assert_eq!(got, Some(EntityTarget::local("a2")));
    }

    #[test]
    fn keeps_a_tidal_track_off_its_hidden_album() {
        let t = row(|t| {
            t.source = Some(TrackSource::Tidal);
            t.album_id = Some("hidden".into());
        });
        let got = resolve_track_album_target(&t, |_| {
            Ok(detail(|d| {
                d.source = TrackSource::Tidal;
                d.album_id = Some("hidden".into());
            }))
        })
        .unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn uses_the_details_source_for_a_row_without_one() {
        let got = resolve_track_album_target(&row(|t| t.id = "tidal:9".into()), |_| {
            Ok(detail(|d| {
                d.source = TrackSource::Tidal;
                d.album_id = Some("hidden".into());
                d.source_album_id = Some("123".into());
            }))
        })
        .unwrap();
        assert_eq!(got, Some(EntityTarget::tidal("123")));
    }

    #[test]
    fn no_album_or_a_failed_read() {
        let t = row(|t| t.source = Some(TrackSource::Local));
        assert_eq!(resolve_track_album_target(&t, |_| Ok(detail(|_| {}))).unwrap(), None);
        let err = resolve_track_album_target(&t, |_| Err(ApiError::transport("offline"))).unwrap_err();
        assert_eq!(err.message, "offline");
    }

    fn replay(f: impl FnOnce(&mut ReplayAlbum)) -> ReplayAlbum {
        let mut a = ReplayAlbum { id: "materialized-album-id".into(), title: "Album".into(), plays: 3, ..Default::default() };
        f(&mut a);
        a
    }

    #[test]
    fn replay_albums() {
        let t = replay(|a| {
            a.source = Some(TrackSource::Tidal);
            a.source_album_id = Some("tidal-album-id".into());
        });
        assert_eq!(replay_album_target(&t), EntityTarget::tidal("tidal-album-id"));
        assert_eq!(
            replay_album_target(&replay(|a| a.source = Some(TrackSource::Local))),
            EntityTarget::local("materialized-album-id")
        );
        assert_eq!(replay_album_target(&replay(|_| {})), EntityTarget::local("materialized-album-id"));
        assert_eq!(
            replay_album_target(&replay(|a| a.source = Some(TrackSource::Tidal))),
            EntityTarget::local("materialized-album-id")
        );
    }

    #[test]
    fn search_results_open_where_they_came_from() {
        assert_eq!(search_entity_target("tidal:42", Some(TrackSource::Tidal), Some("42")), EntityTarget::tidal("42"));
        assert_eq!(search_entity_target("uuid", Some(TrackSource::Local), None), EntityTarget::local("uuid"));
        assert_eq!(search_entity_target("uuid", None, None), EntityTarget::local("uuid"));
        assert_eq!(search_entity_target("tidal:42", Some(TrackSource::Tidal), None), EntityTarget::tidal("42"));
    }

    #[test]
    fn artist_releases_open_where_they_came_from() {
        let lp = SearchAlbum {
            album: Album {
                id: "tidal:42".into(),
                title: "LP".into(),
                track_count: 10,
                duration_ms: 40 * 60_000,
                has_cover: true,
                ..Default::default()
            },
            source: TrackSource::Tidal,
            source_id: Some("42".into()),
            ..Default::default()
        };
        let tidal = &tidal_artist_releases(&[lp])[0];
        assert_eq!(release_target(tidal), EntityTarget::tidal("42"));
        let library = &library_artist_releases(&[row(|t| {
            t.album_id = Some("a1".into());
            t.album_title = Some("LP".into());
        })])[0];
        assert_eq!(release_target(library), EntityTarget::local("a1"));
    }
}
