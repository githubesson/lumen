//! Release menus and cancellable, all-or-nothing collection loading.
use std::collections::HashSet;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use rune::{Cx, El, col, el, row, text};
use crate::{app::App, theme::Theme, api::{Client, TrackListItem, PageParams, ListSort}};
use crate::core::{artist_releases::{ArtistRelease, release_target}, entity_target::{EntityTarget, EntityKind}};
use crate::ui::{Btn, font, icons as i, kit::{Dialog, error_banner}};

#[derive(Clone)]
enum Collection {
    Releases(Vec<ArtistRelease>),
    Library(ListSort),
}

#[derive(Default)]
pub struct State {
    menu: Option<(ArtistRelease, [f32; 2])>,
    request: Option<(Collection, bool)>,
    cancel: Option<Arc<AtomicBool>>,
    serial: u64,
    error: Option<String>,
    loading: bool,
}

impl State {
    pub fn is_open(&self) -> bool { self.menu.is_some() || self.request.is_some() }
}

pub fn open_menu(app: &mut App, release: ArtistRelease, at: [f32; 2]) {
    super::track_menu::close(app);
    close(app);
    app.overlays.collection_play.menu = Some((release, at));
}

pub fn close(app: &mut App) {
    let s = &mut app.overlays.collection_play;
    if let Some(cancel) = s.cancel.take() { cancel.store(true, Ordering::Relaxed); }
    s.serial += 1;
    s.menu = None;
    s.request = None;
    s.error = None;
    s.loading = false;
}

pub fn releases(app: &mut App, releases: Vec<ArtistRelease>, shuffle: bool) {
    start(app, Collection::Releases(releases), shuffle);
}

pub fn library(app: &mut App, shuffle: bool) {
    start(app, Collection::Library(app.pages.library.sort.list_sort()), shuffle);
}

// Preserve release order and album track order, and avoid exact duplicate IDs.
// Folded release versions stay folded: play the same version its tile opens.
fn collect_releases(
    releases: &[ArtistRelease],
    cancel: &AtomicBool,
    mut fetch: impl FnMut(&EntityTarget) -> Result<Vec<TrackListItem>, String>,
) -> Result<Vec<TrackListItem>, String> {
    let mut tracks = Vec::new();
    let mut seen_releases = HashSet::new();
    let mut seen_tracks = HashSet::new();
    for release in releases {
        if cancel.load(Ordering::Relaxed) { return Ok(Vec::new()); }
        let target = release_target(release);
        if !seen_releases.insert(target.clone()) { continue; }
        let rows = fetch(&target).map_err(|_| format!("Could not load “{}”. Your queue has not changed. Retry or cancel.", release.title))?;
        tracks.extend(rows.into_iter().filter(|t| seen_tracks.insert(t.id.clone())));
    }
    Ok(tracks)
}

fn load(client: &Client, collection: &Collection, cancel: &AtomicBool) -> Result<Vec<TrackListItem>, String> {
    match collection {
        Collection::Releases(releases) => collect_releases(releases, cancel, |target| {
            match target.kind {
                EntityKind::Local => crate::api::library::list_album_tracks(client, &target.id),
                EntityKind::Tidal => crate::api::tidal::get_tidal_album(client, &target.id).map(|a| a.tracks),
            }.map_err(|_| "Release unavailable".into())
        }),
        Collection::Library(sort) => {
            let mut tracks = Vec::new();
            let mut offset = 0;
            let mut seen = HashSet::new();
            loop {
                if cancel.load(Ordering::Relaxed) { return Ok(Vec::new()); }
                let params = PageParams { sort: Some(*sort), ..PageParams::new(200, offset) };
                let (rows, total) = crate::api::library::list_tracks(client, &params)
                    .map_err(|_| "Could not load the library. Your queue has not changed. Retry or cancel.".to_string())?;
                let count = rows.len();
                let before = tracks.len();
                tracks.extend(rows.into_iter().filter(|t| seen.insert(t.id.clone())));
                offset += count as u64;
                if offset >= total { break; }
                if count == 0 || tracks.len() == before {
                    return Err("The library changed while loading. Retry to load it again.".into());
                }
            }
            Ok(tracks)
        }
    }
}

fn start(app: &mut App, collection: Collection, shuffle: bool) {
    close(app);
    let s = &mut app.overlays.collection_play;
    s.request = Some((collection.clone(), shuffle));
    let Some(client) = app.client.clone() else {
        s.error = Some("Connect to your music server, then retry.".into());
        return;
    };
    s.loading = true;
    let serial = s.serial;
    let cancel = Arc::new(AtomicBool::new(false));
    s.cancel = Some(cancel.clone());
    app.net.run(move || load(&client, &collection, &cancel), move |app, result| {
        if app.overlays.collection_play.serial != serial { return; }
        app.overlays.collection_play.loading = false;
        match result {
            Ok(tracks) if tracks.iter().any(|t| t.unavailable != Some(true)) => {
                close(app);
                crate::ui::track_row::start_list(app, &tracks, shuffle);
            }
            Ok(_) => app.overlays.collection_play.error = Some("No playable tracks in this collection. Your queue has not changed.".into()),
            Err(message) => app.overlays.collection_play.error = Some(message),
        }
    });
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let s = &app.overlays.collection_play;
    let win = crate::shell::window_size(cx);
    if let Some((release, at)) = &s.menu {
        let play = release.clone();
        let shuffle = release.clone();
        let target = release_target(release);
        let panel = crate::ui::kit::menu_panel(t, "release-menu", Some(240.0))
            .absolute(at[0].min(win[0] - 248.0).max(8.0), at[1].min(win[1] - 190.0).max(8.0))
            .label(release.title.clone())
            .child(text(release.title.clone()).font(font(14.0, 600.0)).color(t.c.foreground).max_w(220.0).truncate())
            .child(super::track_menu::list_item(t, "release-play", Some(&i::PLAY_FILLED), "Play", false, true)
                .on_press(move |app: &mut App| releases(app, vec![play.clone()], false)))
            .child(super::track_menu::list_item(t, "release-shuffle", Some(&i::SHUFFLE), "Shuffle play", false, true)
                .on_press(move |app: &mut App| releases(app, vec![shuffle.clone()], true)))
            .child(super::track_menu::list_item(t, "release-open", None, "Open release", false, true)
                .on_press(move |app: &mut App| { close(app); crate::pages::library::open_album(app, target.clone()); }));
        return Some(el().key("release-menu-layer").pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).modal(true, close)
            .child(el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).on_press(close).on_secondary_press(|app: &mut App, _, _| close(app)))
            .child(panel));
    }
    let (collection, shuffle) = s.request.as_ref()?;
    let title = match collection {
        Collection::Releases(r) if r.len() == 1 => r[0].title.as_str(),
        Collection::Releases(_) => "Artist discography",
        Collection::Library(_) => "Music library",
    };
    let mut body = col().padding(20.0).gap(12.0)
        .child(text(title.to_string()).font(font(20.0, 600.0)).color(t.c.foreground));
    if s.loading { body = body.child(text("Loading tracks…").font(font(14.0, 400.0)).color(t.c.muted_foreground)); }
    if let Some(error) = &s.error { body = body.child(error_banner(t, error)); }
    let mut footer = row().padding(16.0).gap(8.0).child(Btn::new("collection-cancel", "Cancel").build(t).on_press(close));
    if !s.loading {
        let (collection, shuffle) = (collection.clone(), *shuffle);
        footer = footer.child(Btn::new("collection-retry", "Retry").primary().build(t)
            .on_press(move |app: &mut App| start(app, collection.clone(), shuffle)));
    }
    Some(Dialog::new("collection-load", body).max_width(440.0).footer(footer).build(t, win, close))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn track(id: &str) -> TrackListItem { TrackListItem { id: id.into(), ..Default::default() } }
    fn release(id: &str) -> ArtistRelease { ArtistRelease { id: id.into(), title: id.into(), ..Default::default() } }
    #[test]
    fn complete_releases_in_order_and_no_duplicate_ids() {
        let mut calls = Vec::new();
        let releases = [release("album"), release("ep"), release("single"), release("album")];
        let rows = collect_releases(&releases, &AtomicBool::new(false), |target| {
            calls.push(target.id.clone());
            Ok(vec![track(&target.id), track("shared")])
        }).unwrap();
        assert_eq!(calls, ["album", "ep", "single"]);
        assert_eq!(rows.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["album", "shared", "ep", "single"]);
    }
    #[test]
    fn failed_release_does_not_return_partial_discography() {
        let result = collect_releases(&[release("ok"), release("broken")], &AtomicBool::new(false), |target| {
            if target.id == "broken" { Err("offline".into()) } else { Ok(vec![track("one")]) }
        });
        assert!(result.unwrap_err().contains("broken"));
    }
    #[test]
    fn cancel_stops_between_releases() {
        let cancel = AtomicBool::new(false);
        let mut calls = 0;
        let rows = collect_releases(&[release("a"), release("b")], &cancel, |_| {
            calls += 1; cancel.store(true, Ordering::Relaxed); Ok(vec![track("one")])
        }).unwrap();
        assert!(rows.is_empty()); assert_eq!(calls, 1);
    }
}
