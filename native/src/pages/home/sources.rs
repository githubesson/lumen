//! Home's sources (`useApiResource` per list in `Home.tsx`, `ReplaySource`,
//! `PlaylistSource`, `HeroAlbum`'s and `HeroTracks`' loads): each loads into
//! a [`Res`] in [`State`], kept between visits as the web's resource cache
//! keeps them, and revalidated on each visit.

use std::collections::HashMap;

use crate::api::{ApiResult, Client, TrackListItem};
use crate::app::App;

use super::kinds::DEFAULT_PERIOD;
use super::logic::{Period, error_message, replay_query};
use super::panels::LIST_ROWS;
use super::requests::{self, ReplayBucket, ReplayData};
use super::{Res, State};

/// Recently played is asked for in steps of this many, enough to fill its
/// panel; so is Recently added, from the newest tracks.
pub const RECENT_STEP: usize = 20;
/// The newest tracks, per six album covers: usually enough to find them.
pub const TRACKS_PER_SIX_ALBUMS: usize = 80;
/// The most tracks the server sends in one page.
pub const MAX_TRACKS: usize = 500;

/// Starts a load into the resource `slot` names, dropping a reply that a
/// later load superseded.
fn load<T: Send + 'static>(
    app: &mut App,
    slot: impl Fn(&mut State) -> &mut Res<T> + Send + Clone + 'static,
    fetch: impl FnOnce(&Client) -> ApiResult<T> + Send + 'static,
    fallback: &'static str,
) {
    let Some(client) = app.client.clone() else { return };
    let res = slot(&mut app.pages.home);
    res.serial += 1;
    res.loading = true;
    res.error = None;
    let serial = res.serial;
    app.net.run(
        move || fetch(&client),
        move |app, result| {
            let res = slot(&mut app.pages.home);
            if res.serial != serial {
                return;
            }
            res.loading = false;
            match result {
                Ok(data) => res.data = Some(data),
                Err(e) => res.error = Some(error_message(&e, fallback)),
            }
            super::after_load(app);
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
    load(app, |s| &mut s.recent, move |c| requests::list_recent(c, limit), "Could not load recently played tracks.");
}

pub fn load_tracks(app: &mut App) {
    let limit = app.pages.home.track_limit.max(TRACKS_PER_SIX_ALBUMS);
    app.pages.home.tracks_sent = limit;
    load(app, |s| &mut s.tracks, move |c| requests::list_tracks(c, limit), "Could not load your library.");
}

/// TODO(api-merge): the favorites context (`useFavorites`) is app-wide in
/// the web app; Home keeps its own copy until one lands.
pub fn load_favorites(app: &mut App) {
    load(app, |s| &mut s.favorites, requests::list_favorites, "Could not load favorites.");
}

/// `usePlaylists().reload`: the shell's list, with Home tracking its state.
pub fn load_playlists(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let home = &mut app.pages.home;
    home.playlists_serial += 1;
    home.playlists_loading = true;
    home.playlists_error = None;
    let serial = home.playlists_serial;
    app.net.run(
        move || requests::list_playlists(&client),
        move |app, result| {
            if app.pages.home.playlists_serial != serial {
                return;
            }
            app.pages.home.playlists_loading = false;
            match result {
                Ok(list) => app.playlists = Some(list),
                Err(e) => {
                    app.pages.home.playlists_error = Some(error_message(&e, "Could not load playlists."));
                    // Latched, so retrying the list doesn't empty the panels meanwhile.
                    if app.playlists.is_none() {
                        app.pages.home.list_failed = true;
                    }
                }
            }
            super::after_load(app);
        },
    );
}

/// `ReplaySource`: a period's numbers, by day, under the key Replay reads;
/// all time again by month when the days came back cut short.
pub fn load_replay(app: &mut App, period: Period) {
    let key = period.key();
    let q = replay_query(period);
    let fallback = super::replay_error(period);
    let k = key.clone();
    let Some(client) = app.client.clone() else { return };
    let res = app.pages.home.replay.entry(key.clone()).or_default();
    res.serial += 1;
    res.loading = true;
    res.error = None;
    let serial = res.serial;
    app.net.run(
        move || {
            let daily = requests::get_replay(&client, q.from.clone(), q.to.clone(), ReplayBucket::Day)?;
            let counted: u64 = daily.activity.iter().map(|b| b.plays).sum();
            if q.range.from.is_none() && counted < daily.summary.total_plays {
                return requests::get_replay(&client, None, None, ReplayBucket::Month);
            }
            Ok(daily)
        },
        move |app, result: ApiResult<ReplayData>| {
            let home = &mut app.pages.home;
            let Some(res) = home.replay.get_mut(&k) else { return };
            if res.serial != serial {
                return;
            }
            res.loading = false;
            match result {
                Ok(data) => {
                    for y in &data.available_years {
                        if !home.years.contains(y) {
                            home.years.push(*y);
                        }
                    }
                    res.data = Some(data);
                }
                Err(e) => res.error = Some(error_message(&e, &fallback)),
            }
            super::after_load(app);
        },
    );
}

/// `PlaylistSource`.
pub fn load_playlist(app: &mut App, id: &str) {
    let (key, pid) = (id.to_string(), id.to_string());
    app.pages.home.playlist_tracks.entry(key.clone()).or_default();
    load(
        app,
        move |s| s.playlist_tracks.entry(key.clone()).or_default(),
        move |c| requests::list_playlist_tracks(c, &pid),
        "Could not load the playlist.",
    );
}

/// `HeroAlbum`'s album, for its year and length.
pub fn load_hero_album(app: &mut App, id: &str) {
    let (key, aid) = (id.to_string(), id.to_string());
    load(app, move |s| s.hero_album.entry(key.clone()).or_default(), move |c| requests::get_album(c, &aid), "Could not load the album.");
}

/// `HeroTracks`' list, loaded only once there's room for it.
pub fn load_hero_tracks(app: &mut App, id: &str) {
    let (key, aid) = (id.to_string(), id.to_string());
    load(
        app,
        move |s| s.hero_tracks.entry(key.clone()).or_default(),
        move |c| requests::list_album_tracks(c, &aid),
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
/// (`useReloadWhenLarger`). True when it started anything.
pub fn apply(app: &mut App, needs: &Needs) -> bool {
    let mut started = false;
    for p in &needs.periods {
        if !app.pages.home.replay.contains_key(&p.key()) {
            load_replay(app, *p);
            started = true;
        }
    }
    for id in &needs.pinned {
        if !app.pages.home.playlist_tracks.contains_key(id) {
            load_playlist(app, id);
            started = true;
        }
    }
    if let Some(id) = &needs.hero_album
        && !app.pages.home.hero_album.contains_key(id)
    {
        load_hero_album(app, id);
        started = true;
    }
    if let Some(id) = &needs.hero_tracks
        && !app.pages.home.hero_tracks.contains_key(id)
    {
        load_hero_tracks(app, id);
        started = true;
    }
    let home = &mut app.pages.home;
    home.wants = needs.wants.iter().cloned().collect::<HashMap<_, _>>();
    home.recent_limit = recent_limit(home, &needs.recent_panels);
    home.track_limit = track_limit(home, &needs.album_panels, &needs.added_panels);
    if home.recent_limit > home.recent_sent {
        load_recent(app);
        started = true;
    }
    if app.pages.home.track_limit > app.pages.home.tracks_sent {
        load_tracks(app);
        started = true;
    }
    started
}

/// The default period's request, for scenes and tests.
pub fn default_period() -> Period {
    DEFAULT_PERIOD
}

/// The newest tracks the hero falls back to, for `play`'s queue.
pub fn fallback_queue(state: &State) -> Vec<TrackListItem> {
    match state.recent.data.as_deref() {
        Some(r) if !r.is_empty() => r.to_vec(),
        _ => state.tracks.data.clone().unwrap_or_default(),
    }
}
