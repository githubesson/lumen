//! Home's sources (`useApiResource` per list in `Home.tsx`, `ReplaySource`,
//! `PlaylistSource`, `HeroAlbum`'s and `HeroTracks`' loads): each loads into
//! a [`Res`] in [`State`], kept between visits as the web's resource cache
//! keeps them, and revalidated on each visit.

use std::collections::HashMap;

use crate::api::{ApiResult, Client, TrackListItem};
use crate::app::App;
use crate::core::dates::now_ms;
use crate::core::replay::data::fetch_replay;
use crate::core::replay::figures::replay_queries;
use crate::resource::Res;

use super::State;
use super::logic::Period;
use super::panels::LIST_ROWS;

/// Recently played is asked for in steps of this many, enough to fill its
/// panel; so is Recently added, from the newest tracks.
pub const RECENT_STEP: usize = 20;
/// The newest tracks, per six album covers: usually enough to find them.
pub const TRACKS_PER_SIX_ALBUMS: usize = 80;
/// The most tracks the server sends in one page.
pub const MAX_TRACKS: usize = 500;

/// Starts a load into the resource `slot` names; once its reply lands (a
/// later load supersedes it), starts what the board needs next.
fn load<T: Send + 'static>(
    app: &mut App,
    slot: impl Fn(&mut State) -> &mut Res<T> + Send + 'static,
    fetch: impl FnOnce(&Client) -> ApiResult<T> + Send + 'static,
    fallback: &'static str,
) {
    let Some(client) = app.client.clone() else { return };
    let ticket = slot(&mut app.pages.home).begin();
    app.net.run(
        move || fetch(&client),
        move |app, result| {
            if slot(&mut app.pages.home).settle(ticket, result, fallback) {
                super::after_load(app);
            }
        },
    );
}

/// `wanted(kind, usual)`: the most any panel of `kind` asks for.
fn wanted(state: &State, ids: &[String], usual: usize) -> usize {
    ids.iter().filter_map(|id| state.wants.get(id)).copied().fold(usual, usize::max)
}

/// How many recently played tracks the board asks for.
pub fn recent_limit(state: &State, recent_panels: &[String]) -> usize {
    wanted(state, recent_panels, LIST_ROWS).div_ceil(RECENT_STEP) * RECENT_STEP
}

/// How many of the newest tracks: for the hero before anything is played,
/// Albums and Recently added.
pub fn track_limit(state: &State, album_panels: &[String], added_panels: &[String]) -> usize {
    let albums = wanted(state, album_panels, 4).max(6).div_ceil(6) * TRACKS_PER_SIX_ALBUMS;
    let added = wanted(state, added_panels, LIST_ROWS).div_ceil(RECENT_STEP) * RECENT_STEP;
    albums.max(added).min(MAX_TRACKS)
}

pub fn load_recent(app: &mut App) {
    let limit = app.pages.home.recent_limit.max(RECENT_STEP);
    app.pages.home.recent_sent = limit;
    load(app, |s| &mut s.recent, move |c| crate::api::library::list_recent(c, limit as u32), "Could not load recently played tracks.");
}

pub fn load_tracks(app: &mut App) {
    let limit = app.pages.home.track_limit.max(TRACKS_PER_SIX_ALBUMS);
    app.pages.home.tracks_sent = limit;
    load(app, |s| &mut s.tracks, move |c| crate::api::library::list_tracks(c, &crate::api::PageParams { limit: Some(limit as u32), ..Default::default() }).map(|(t, _)| t), "Could not load your library.");
}

/// `useFavorites().refresh`: the app-wide favourites store reads again.
pub fn load_favorites(app: &mut App) {
    crate::pages::favorites::refresh(app);
}

/// `usePlaylists().reload`: the shell's list, which Home's panels read.
pub fn load_playlists(app: &mut App) {
    app.load_playlists_then(|app| {
        // Latched, so retrying the list doesn't empty the panels meanwhile.
        if app.playlists.error.is_some() && app.playlists.data.is_none() {
            app.pages.home.list_failed = true;
        }
        super::after_load(app);
    });
}

/// `ReplaySource`: a period's numbers, by day, under the key Replay reads;
/// all time again by month when the days came back cut short (Replay's own
/// `fetchReplay`). The years with plays it lists are the settings' periods.
pub fn load_replay(app: &mut App, period: Period) {
    let key = period.key();
    let queries = replay_queries(period, now_ms());
    let fallback = super::replay_error(period);
    let Some(client) = app.client.clone() else { return };
    let ticket = app.pages.home.replay.entry(key.clone()).or_default().begin();
    app.net.run(
        move || fetch_replay(&client, &queries, false).map(|(_, data)| data),
        move |app, result| {
            let home = &mut app.pages.home;
            let Some(res) = home.replay.get_mut(&key) else { return };
            if !res.settle(ticket, result, &fallback) {
                return;
            }
            for y in res.data.as_ref().map_or(&[][..], |d| &d.available_years) {
                if !home.years.contains(y) {
                    home.years.push(*y);
                }
            }
            super::after_load(app);
        },
    );
}

/// `PlaylistSource`.
pub fn load_playlist(app: &mut App, id: &str) {
    let (key, pid) = (id.to_string(), id.to_string());
    load(
        app,
        move |s| s.playlist_tracks.entry(key.clone()).or_default(),
        move |c| crate::api::playlists::list_playlist_tracks(c, &pid).map(|l| l.tracks.iter().map(|e| e.as_track()).collect::<Vec<_>>()),
        "Could not load the playlist.",
    );
}

/// `HeroAlbum`'s album, for its year and length.
pub fn load_hero_album(app: &mut App, id: &str) {
    let (key, aid) = (id.to_string(), id.to_string());
    load(app, move |s| s.hero_album.entry(key.clone()).or_default(), move |c| crate::api::library::get_album(c, &aid), "Could not load the album.");
}

/// `HeroTracks`' list, loaded only once there's room for it.
pub fn load_hero_tracks(app: &mut App, id: &str) {
    let (key, aid) = (id.to_string(), id.to_string());
    load(
        app,
        move |s| s.hero_tracks.entry(key.clone()).or_default(),
        move |c| crate::api::library::list_album_tracks(c, &aid),
        "Could not load the album's tracks.",
    );
}

/// What the board needs loaded, as its view worked it out (the web's
/// loaders mounting with the board, and `useWant`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Needs {
    pub periods: Vec<Period>,
    pub pinned: Vec<String>,
    /// Each paged panel's ask, by kind: recently played, newest tracks for
    /// Albums, newest tracks for Recently added.
    pub wants: Vec<(String, usize)>,
    pub recent_panels: Vec<String>,
    pub album_panels: Vec<String>,
    pub added_panels: Vec<String>,
    pub hero_album: Option<String>,
    pub hero_tracks: Option<String>,
}

/// Starts whatever `needs` asks for that isn't loaded or loading yet, and a
/// larger page of a paged list once a panel's room outgrows the last one
/// (`useReloadWhenLarger`).
pub fn apply(app: &mut App, needs: &Needs) {
    for p in &needs.periods {
        if !app.pages.home.replay.contains_key(&p.key()) {
            load_replay(app, *p);
        }
    }
    for id in &needs.pinned {
        if !app.pages.home.playlist_tracks.contains_key(id) {
            load_playlist(app, id);
        }
    }
    if let Some(id) = &needs.hero_album
        && !app.pages.home.hero_album.contains_key(id)
    {
        load_hero_album(app, id);
    }
    if let Some(id) = &needs.hero_tracks
        && !app.pages.home.hero_tracks.contains_key(id)
    {
        load_hero_tracks(app, id);
    }
    let home = &mut app.pages.home;
    home.wants = needs.wants.iter().cloned().collect::<HashMap<_, _>>();
    home.recent_limit = recent_limit(home, &needs.recent_panels);
    home.track_limit = track_limit(home, &needs.album_panels, &needs.added_panels);
    if home.recent_limit > home.recent_sent {
        load_recent(app);
    }
    if app.pages.home.track_limit > app.pages.home.tracks_sent {
        load_tracks(app);
    }
}

/// The newest tracks the hero falls back to, for `play`'s queue.
pub fn fallback_queue(state: &State) -> Vec<TrackListItem> {
    match state.recent.data.as_deref() {
        Some(r) if !r.is_empty() => r.to_vec(),
        _ => state.tracks.data.clone().unwrap_or_default(),
    }
}
