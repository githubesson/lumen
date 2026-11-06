//! Every route of the UI-lint mock API (`frontend/tests/ui/mock-api.ts`,
//! served by `native/tools/mock-server.ts`) through the typed calls, so a
//! payload the types can't decode fails here rather than on a page.
//!
//! Runs only with `LUMEN_MOCK_API=http://127.0.0.1:4791` set (and the mock
//! server up); otherwise it passes without a request. It never signs in or
//! out, so it can share a server with other runs.

use super::admin as adm;
use super::*;
use crate::core::replay::figures::replay_queries;
use crate::core::replay::period::Period;

struct Run {
    failures: Vec<String>,
    passed: usize,
}

impl Run {
    fn check<T>(&mut self, what: &str, r: ApiResult<T>) -> Option<T> {
        match r {
            Ok(v) => {
                self.passed += 1;
                Some(v)
            }
            Err(e) => {
                self.failures.push(format!("{what}: {e} ({:?})", e.kind));
                None
            }
        }
    }

    /// A call the mock answers with an error status on purpose.
    fn expect_status<T>(&mut self, what: &str, r: ApiResult<T>, status: u16) {
        match r {
            Err(e) if e.has_status(status) => self.passed += 1,
            Err(e) => self.failures.push(format!("{what}: wanted {status}, got {e}")),
            Ok(_) => self.failures.push(format!("{what}: wanted {status}, got a success")),
        }
    }
}

#[test]
fn decodes_every_mock_route() {
    let Ok(base) = std::env::var("LUMEN_MOCK_API") else {
        eprintln!("LUMEN_MOCK_API unset: skipping the mock API decode run");
        return;
    };
    let c = Client::new(&base, None);
    let mut run = Run { failures: Vec::new(), passed: 0 };

    // Auth
    let me = run.check("auth::me", auth::me(&c));
    assert!(me.is_some(), "the mock server must be signed in: {:?}", run.failures);
    run.check("auth::check_invite", auth::check_invite(&c, "abcdefghijklmnop"));
    run.check("auth::logout", auth::logout(&c));

    // Library
    let page = PageParams { limit: Some(50), sort: Some(ListSort::Title), ..Default::default() };
    let (tracks, total) = run.check("library::list_tracks", library::list_tracks(&c, &page)).unwrap_or_default();
    assert!(!tracks.is_empty() && total >= tracks.len() as u64, "tracks: {total}");
    let searched = PageParams { q: Some(tracks[0].title.chars().take(3).collect()), ..page.clone() };
    run.check("library::list_tracks q", library::list_tracks(&c, &searched));
    let t = tracks.iter().find(|t| t.album_id.is_some()).unwrap_or(&tracks[0]).clone();
    run.check("tracks/:id/cover", c.bytes(&media::cover_path(&t.id, Some(64))));
    run.check("tracks/:id/stream", c.bytes(&media::stream_path(&t.id)));
    let detail = run.check("library::get_track", library::get_track(&c, &t.id));
    run.check("activity::record_play", activity::record_play(&c, &t.id, 1.0));
    run.check("activity::scrobble_track", activity::scrobble_track(&c, &t.id, 1_790_000_000, 120.0));
    run.check("activity::update_now_playing", activity::update_now_playing(&c, &t.id));
    run.check("favorites::favorite", favorites::favorite(&c, &t.id));
    run.check("favorites::unfavorite", favorites::unfavorite(&c, &t.id));
    let link = run.check("share::create_track_share_link", share::create_track_share_link(&c, &t.id, 12.0, 30.0));
    if let Some(link) = link {
        assert!(share::parse_track_share_url(&link.url).is_some(), "share url {}", link.url);
    }

    let (albums, _) = run.check("library::list_albums", library::list_albums(&c, &PageParams::new(50, 0))).unwrap_or_default();
    if let Some(a) = albums.first() {
        run.check("albums/:id/cover", c.bytes(&media::album_cover_path(&a.id, Some(64), None)));
        run.check("library::list_album_tracks", library::list_album_tracks(&c, &a.id));
        let album = run.check("library::get_album", library::get_album(&c, &a.id));
        if let Some(album) = album {
            let credits = crate::core::entity_labels::album_credits((&album).into());
            assert!(!credits.is_empty() || album.artist_name.is_none());
        }
    }
    run.expect_status("library::get_album missing", library::get_album(&c, "no-such-album"), 404);

    let tidal_artist = run.check("tidal::get_tidal_artist", tidal::get_tidal_artist(&c, "4419021"));
    if let Some(artist) = tidal_artist {
        let releases = crate::core::artist_releases::tidal_artist_releases(&artist.albums);
        let folded = crate::core::artist_releases::fold_release_versions(&releases);
        assert!(folded.len() <= releases.len());
        // The fixture serves only some of the artist's releases as albums.
        let mut served = 0;
        for a in &artist.albums {
            let id = search::search_entity_id(&a.album.id, Some(a.source), a.source_id.as_deref());
            match tidal::get_tidal_album(&c, &id) {
                Ok(album) => {
                    served += 1;
                    let _ = crate::core::entity_labels::tidal_album_facts(&album, &[]);
                }
                Err(e) if e.has_status(404) => {}
                Err(e) => run.failures.push(format!("tidal::get_tidal_album {id}: {e}")),
            }
        }
        if served == 0 {
            run.failures.push("tidal::get_tidal_album: no release served".into());
        }
        run.passed += served;
    }

    let (artists, _) = run.check("library::list_artists", library::list_artists(&c, &PageParams::new(50, 0))).unwrap_or_default();
    if let Some(a) = artists.first() {
        run.check("library::list_artist_tracks", library::list_artist_tracks(&c, &a.id));
        run.check("library::get_artist", library::get_artist(&c, &a.id));
    }

    for kind in [search::SearchType::All, search::SearchType::Track, search::SearchType::Album, search::SearchType::Artist] {
        let params = search::SearchParams {
            page: PageParams { q: Some("a".into()), ..Default::default() },
            kind: Some(kind),
            sources: None,
        };
        run.check(&format!("search::search_page {}", kind.as_str()), search::search_page(&c, &params));
    }
    run.check("covers/remote", c.bytes(&media::remote_cover_path("https://resources.tidal.com/x.jpg")));
    if let Some(a) = albums.first() {
        let signed = run.check("media::sign_album_cover", media::sign_album_cover(&c, &a.id));
        if let Some(s) = signed {
            run.check("public/covers/album", c.bytes(&s.url));
        }
    }
    let lyrics = run.check("lyrics::get_lyrics", lyrics::get_lyrics(&c, &crate::core::lyrics::lyrics_request_for(&t)));
    if let Some(l) = lyrics {
        let _ = crate::core::lyrics::lyrics_content(Some(&l));
    }

    // Listening
    run.check("favorites::list_favorites", favorites::list_favorites(&c));
    run.check("library::list_recent", library::list_recent(&c, 100));
    for period in [Period::All, Period::ThisYear, Period::Last30, Period::ThisMonth] {
        let q = replay_queries(period, crate::core::dates::now_ms());
        if let Some((_, data)) = run.check("stats::get_replay", crate::core::replay::data::fetch_replay(&c, &q, false)) {
            let _ = crate::core::replay::figures::replay_calendar(&data.activity, data.bucket, &q.range, crate::core::dates::now_ms());
        }
        if let Some(m) = &q.monthly {
            run.check("stats::get_replay monthly", stats::get_replay(&c, &m.params));
        }
    }
    run.check("activity::current_activity", activity::current_activity(&c, Some("rune-test")));
    let input = PlaybackActivityInput {
        device_id: "rune-test".into(),
        device_name: "Rune test".into(),
        track_id: t.id.clone(),
        title: t.title.clone(),
        position_sec: 1.0,
        is_playing: false,
        ..Default::default()
    };
    run.check("activity::upsert_playback_activity", activity::upsert_playback_activity(&c, &input));
    run.check("activity::clear_playback_activity", activity::clear_playback_activity(&c, "rune-test"));
    run.check("lastfm::get_lastfm_status", lastfm::get_lastfm_status(&c));

    // Playlists
    let playlists = run.check("playlists::list_playlists", playlists::list_playlists(&c, None)).unwrap_or_default();
    run.check("playlists::list_playlists track_id", playlists::list_playlists(&c, Some(&t.id)));
    run.check("playlists::list_pending_invites", playlists::list_pending_invites(&c));
    for p in &playlists {
        run.check("playlists::get_playlist", playlists::get_playlist(&c, &p.id));
        run.check("playlists::list_playlist_tracks", playlists::list_playlist_tracks(&c, &p.id));
        let first = run.check("playlists::if_changed", playlists::list_playlist_tracks_if_changed(&c, &p.id, None));
        if let Some(etag) = first.and_then(|f| f.etag) {
            run.check("playlists::if_changed etag", playlists::list_playlist_tracks_if_changed(&c, &p.id, Some(&etag)));
        }
        run.check("playlists::list_collaborators", playlists::list_collaborators(&c, &p.id));
        if let Some(v) = &p.custom_cover {
            run.check("playlists/:id/cover", c.bytes(&media::playlist_cover_path(&p.id, v, Some(64))));
        }
        let _ = crate::core::playlist_permissions::playlist_permissions(Some(p), me.as_ref());
    }

    // Admin
    if let Some(d) = &detail {
        run.check("admin::link_track", adm::link_track(&c, &d.id, "other"));
        run.check("admin::unlink_track", adm::unlink_track(&c, &d.id));
        let view = crate::core::tidal::track_info::track_info_rows(d, None, None);
        assert!(!view.sections.is_empty());
    }
    run.check("admin::list_users", adm::list_users(&c));
    run.check("admin::list_invites", adm::list_invites(&c));
    run.check("admin::list_music_roots", adm::list_music_roots(&c));
    run.check("admin::music_root_usage", adm::music_root_usage(&c, false));
    run.check("admin::list_ingest_errors", adm::list_ingest_errors(&c));
    run.check("admin::rescan_status", adm::rescan_status(&c));
    let grid = run.check("sources::list_artist_grid_pins", sources::list_artist_grid_pins(&c)).unwrap_or_default();
    let filen = run.check("sources::list_filen_pins", sources::list_filen_pins(&c)).unwrap_or_default();
    let trackers = run.check("sources::list_api_tracker_pins", sources::list_api_tracker_pins(&c)).unwrap_or_default();
    for p in grid.iter().filter(|p| sources::is_valid_pin_id(&p.id)) {
        run.check("sources::list_artist_grid_downloads", sources::list_artist_grid_downloads(&c, &p.id, 0));
    }
    for p in filen.iter().filter(|p| sources::is_valid_pin_id(&p.id)) {
        run.check("sources::list_filen_downloads", sources::list_filen_downloads(&c, &p.id, 0));
    }
    for p in trackers.iter().filter(|p| sources::is_valid_pin_id(&p.id)) {
        run.check("sources::list_api_tracker_downloads", sources::list_api_tracker_downloads(&c, &p.id, 0));
    }
    run.check("tidal::tidal_status", tidal::tidal_status(&c));
    run.check("tidal::tidal_auto_download", tidal::tidal_auto_download(&c));

    // Public share page
    let share = run.check("share::get_public_track_share", share::get_public_track_share(&c, &t.id, 12.0, "4b1d9e", Some(30.0)));
    if let Some(s) = share {
        assert_eq!(s.track_id, t.id);
    }
    let r = share::TrackShareRef { track_id: t.id.clone(), sig: "4b1d9e".into(), start_sec: 0, duration_sec: Some(30) };
    run.expect_status("public/preview-videos", c.bytes(&share::track_share_preview_video_path(&r)), 404);

    eprintln!("mock API: {} calls decoded", run.passed);
    assert!(run.failures.is_empty(), "{} failed:\n{}", run.failures.len(), run.failures.join("\n"));
}
