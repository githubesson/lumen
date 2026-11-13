//! `LibraryDetail.tsx`'s album pages (`AlbumDetailView`,
//! `TidalAlbumDetailView`, `NotFound`), `ReleaseVersionPicker.tsx`,
//! `useReleaseVersions.ts` and `AlbumDownloadControl.tsx`.

use std::time::Duration;

use rune::{Cursor, Cx, El, col, el, row, text};

use crate::api::TrackListItem;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::{SelectOption, SelectVariant, select};
use crate::ui::kit::{empty_state, error_banner};
use crate::ui::{Btn, BtnState, font, ico, icons as i, iconbtn};

use crate::ui::track_list::TrackList;
use super::logic::{self, AlbumDownloadState, ArtistRelease, EntityTarget};
use crate::api::{self, Client, error_message};
use super::sleeve::{self, Sleeve, SleeveAlbum};

const LIBRARY_SAVED_HINT: &str = "The rest of the release plays from TIDAL";
const TIDAL_SAVED_HINT: &str = "Played from the library instead of TIDAL";
const LOADING_FACTS: &[&str] = &["Released", "Length"];
const TIDAL_LOADING_FACTS: &[&str] = &["Released", "Length", "Saved"];

fn is_admin(app: &App) -> bool {
    app.me().is_some_and(|m| m.is_admin())
}

// ---------------------------------------------------------------- loading

/// `AlbumDetailView`'s mount: the cached copy at once, then a fresh read.
pub fn enter_library(app: &mut App, id: &str) {
    if super::mount(app, format!("album:{id}"), id) {
        let s = &mut app.pages.library;
        if let Some((a, t)) = s.cache.albums.get(id).cloned() {
            s.detail.album = Some(a);
            s.detail.tracks = Some(t);
        }
        super::landed(app);
    }
    load_library(app, false);
}

/// Read the album and its tracks; `quiet` refreshes keep the page on failure.
fn load_library(app: &mut App, quiet: bool) {
    super::load_detail(
        app,
        quiet,
        |c: &Client, id: &str| -> api::ApiResult<_> { Ok((api::library::get_album(c, id)?, api::library::list_album_tracks(c, id)?)) },
        "Failed to load album.",
        |app, (album, tracks)| {
            let s = &mut app.pages.library;
            s.cache.albums.insert(s.detail.id.clone(), (album.clone(), tracks.clone()));
            let queued = album.queued_count.unwrap_or(0);
            s.detail.album = Some(album);
            s.detail.tracks = Some(tracks);
            super::landed(app);
            if queued > 0 {
                arm_refresh(app);
            }
        },
        |app| {
            let s = &mut app.pages.library;
            s.cache.albums.remove(&s.detail.id);
            s.detail.not_found = true;
            false
        },
    );
}

/// `TidalAlbumDetailView`'s mount.
pub fn enter_tidal(app: &mut App, id: &str, artist: Option<&str>) {
    if super::mount(app, format!("tidal-album:{id}"), id) {
        let s = &mut app.pages.library;
        s.detail.tidal_album = s.cache.tidal_albums.get(id).cloned();
        super::landed(app);
    }
    load_tidal(app, false);
    let artist = artist.map(str::to_string).or_else(|| app.pages.library.detail.tidal_album.as_ref().and_then(|a| a.artist_id.clone()));
    if let Some(a) = &artist {
        ensure_versions(app, a);
    }
    sync_versions(app, artist);
}

fn load_tidal(app: &mut App, quiet: bool) {
    super::load_detail(
        app,
        quiet,
        |c: &Client, id: &str| api::tidal::get_tidal_album(c, id),
        "Failed to load TIDAL album.",
        |app, album| {
            let s = &mut app.pages.library;
            s.cache.tidal_albums.insert(s.detail.id.clone(), album.clone());
            let queued = album.queued_count.unwrap_or(0);
            let artist = album.artist_id.clone();
            s.detail.tidal_album = Some(album);
            super::landed(app);
            if queued > 0 {
                arm_refresh(app);
            }
            let from_url = app.location().get("tidalArtist").is_some_and(|a| !a.is_empty());
            if let Some(a) = artist.filter(|_| !from_url) {
                ensure_versions(app, &a);
            }
            sync_versions(app, versions_artist(app));
        },
        |app| {
            // Gone from TIDAL: don't keep showing (or caching) the old copy.
            let s = &mut app.pages.library;
            s.cache.tidal_albums.remove(&s.detail.id);
            s.detail.tidal_album = None;
            super::landed(app);
            sync_versions(app, versions_artist(app));
            true
        },
    );
}

/// `useReleaseVersions`: the TIDAL artist whose releases list the album's
/// versions, from the cache or fetched once. Failures only lose the picker.
fn ensure_versions(app: &mut App, artist_id: &str) {
    let s = &mut app.pages.library;
    if s.cache.tidal_artists.contains_key(artist_id) || !s.cache.fetching.insert(artist_id.to_string()) {
        return;
    }
    let Some(client) = app.client.clone() else { return };
    let id = artist_id.to_string();
    app.net.run(
        {
            let id = id.clone();
            move || api::tidal::get_tidal_artist(&client, &id)
        },
        move |app, result| {
            let c = &mut app.pages.library.cache;
            c.fetching.remove(&id);
            if let Ok(artist) = result {
                c.tidal_artists.insert(id, artist);
                if app.pages.library.detail.key.starts_with("tidal-album:") {
                    sync_versions(app, versions_artist(app));
                }
            }
        },
    );
}

/// The artist whose releases list the open TIDAL album's versions: the
/// URL's `tidalArtist`, else the album's own.
fn versions_artist(app: &App) -> Option<String> {
    let from_url = app.location().get("tidalArtist").filter(|a| !a.is_empty()).map(str::to_string);
    from_url.or_else(|| app.pages.library.detail.tidal_album.as_ref().and_then(|a| a.artist_id.clone()))
}

/// The album's versions among `artist_id`'s releases, if they're loaded.
fn versions(app: &App, artist_id: &str, id: &str) -> Option<Vec<ArtistRelease>> {
    let artist = app.pages.library.cache.tidal_artists.get(artist_id)?;
    logic::release_versions_of(&logic::tidal_artist_releases(&artist.albums), id)
}

/// Work out the picker's versions for `artist` once, when the album or
/// the artist's releases land, rather than each frame.
fn sync_versions(app: &mut App, artist: Option<String>) {
    let versions = artist.map(|a| {
        let v = versions(app, &a, &app.pages.library.detail.id);
        (a, v)
    });
    app.pages.library.detail.versions = versions;
}

/// While tracks are queued, refetch every 15 s so rows flip to their
/// library copies.
fn arm_refresh(app: &mut App) {
    let d = &mut app.pages.library.detail;
    d.refresh_gen += 1;
    let (seq, key) = (d.refresh_gen, d.key.clone());
    let tx = app.net.sender();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(logic::ALBUM_DOWNLOAD_REFRESH_MS));
        tx.send(move |app| {
            let d = &app.pages.library.detail;
            if d.refresh_gen == seq && d.key == key && app.location().is("/library") {
                refresh(app);
            }
        });
    });
}

/// The quiet refetch after a download or cancel.
fn refresh(app: &mut App) {
    if app.pages.library.detail.key.starts_with("tidal-album:") { load_tidal(app, true) } else { load_library(app, true) }
}

// ---------------------------------------------------------------- views

/// The album's track list's key (its selection).
pub const TRACKS_LIST: &str = "album-tracks";

/// `AlbumTrackList`: no row covers or albums, and rows crediting only the
/// album's artists leave their artist line out. The rows are the search's
/// matches; a row plays the whole album.
fn album_tracks(app: &App, t: &Theme, credits: Vec<String>) -> TrackList {
    let mut list = TrackList::new(TRACKS_LIST, super::detail_rows)
        .queue(super::detail_tracks)
        .no_cover()
        .no_album()
        .omit_artists(credits)
        .bar_elsewhere();
    if let Some(q) = super::detail_query(app) {
        list = list.empty(empty_state(t, None, "No matches.", Some(&format!("Nothing in this album matches \"{q}\".")), None));
    }
    list
}

/// A failed first load: the error, in the view. The Library crumb is the way back.
fn load_error(t: &Theme, message: &str) -> El {
    col().key("lib-detail-error").w_full().padding(t.pad()).child(error_banner(t, message))
}

/// `NotFound`.
pub fn not_found(t: &Theme, kind: &str) -> El {
    let back = Btn::new("lib-back", "Back to library").ghost().icon(&i::ARROW_LEFT).build(t).mt(16.0).on_press(super::clear_drill);
    col().key("lib-not-found").w_full().padding(t.pad()).child(
        col()
            .w_full()
            .padding(40.0)
            .items_center()
            .child(crate::ui::exact(text(format!("{kind} not found.")).font(font(14.0, 500.0)).color(t.c.foreground), font(14.0, 500.0).line_height))
            .child(
                crate::ui::exact(text("It may have been removed or renamed.").font(font(14.0, 400.0)).color(t.c.muted_foreground), font(14.0, 400.0).line_height)
                .mt(8.0),
            )
            .child(back),
    )
}

pub fn view_library(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let d = &app.pages.library.detail;
    if d.not_found {
        return not_found(t, "Album");
    }
    let admin = is_admin(app);
    let on_edit: Option<fn(&mut App)> = admin.then_some(|app: &mut App| {
        if let Some(a) = app.pages.library.detail.album.clone() {
            crate::overlays::edit::open_album(app, &a);
        }
    });
    let (Some(album), Some(tracks)) = (&d.album, &d.tracks) else {
        if let Some(e) = &d.error {
            return load_error(t, e);
        }
        return sleeve::view(app, t, cx, loading_sleeve("Album", "Loading album…", false, LOADING_FACTS));
    };
    let nonce = (d.cover_nonce > 0).then(|| d.cover_nonce.to_string());
    let cover = crate::api::media::album_art(&album.id, Some(album.has_cover), None, None, None, nonce.as_deref());
    let mut list = Vec::new();
    if let Some(e) = d.error.as_ref().or(d.action_error.as_ref()) {
        list.push(error_banner(t, e));
    }
    let names: Vec<String> = d.credits.iter().map(|c| c.name.clone()).collect();
    let track_list = Some(album_tracks(app, t, names));
    let actions = match album.tidal_album_id.as_deref().filter(|s| !s.is_empty()) {
        Some(tidal) if admin => download_control(app, t, tidal, tracks, album.queued_count.unwrap_or(0)),
        _ => Vec::new(),
    };
    sleeve::view(
        app,
        t,
        cx,
        Sleeve {
            kind: "Album",
            album: Some(SleeveAlbum {
                title: album.title.clone(),
                cover,
                credits: &d.credits,
                facts: &d.facts,
                saved_hint: LIBRARY_SAVED_HINT,
                tracks,
            }),
            loading_label: "Loading album…",
            versions: None,
            actions,
            reserve_actions: false,
            loading_facts: LOADING_FACTS,
            details_link: None,
            on_edit,
            matches: (d.rows.len(), tracks.len()),
            list,
            track_list,
        },
    )
}

fn loading_sleeve(kind: &'static str, label: &'static str, reserve: bool, facts: &'static [&'static str]) -> Sleeve<'static> {
    Sleeve {
        kind,
        album: None,
        loading_label: label,
        versions: None,
        actions: Vec::new(),
        reserve_actions: reserve,
        loading_facts: facts,
        details_link: None,
        on_edit: None,
        matches: (0, 0),
        list: Vec::new(),
        track_list: None,
    }
}

pub fn view_tidal(app: &App, t: &Theme, cx: &mut Cx<App>, id: &str, artist_param: Option<&str>) -> El {
    let d = &app.pages.library.detail;
    let admin = is_admin(app);
    let versions_artist = artist_param.map(str::to_string).or_else(|| d.tidal_album.as_ref().and_then(|a| a.artist_id.clone()));
    // Worked out as the data landed; afresh only if the artist differs since.
    let fresh;
    let listed = match (&d.versions, versions_artist.as_deref()) {
        (Some((a, v)), Some(artist)) if a == artist => v.as_deref(),
        (_, Some(artist)) => {
            fresh = versions(app, artist, id);
            fresh.as_deref()
        }
        (_, None) => None,
    };
    let picker = listed.zip(versions_artist.as_deref()).map(|(v, artist)| version_picker(app, t, cx, v, id, artist));
    let Some(album) = &d.tidal_album else {
        if let Some(e) = &d.error {
            // The banner's text centres too (`text-align: center` on the box).
            let banner = crate::ui::css_border(rune::el(), 1.0, t.c.destructive_border, t.radius_lg())
                .w_full()
                .px(13.0)
                .py(9.0)
                .radius(t.radius_lg())
                .fill(t.c.destructive_soft)
                .child(text(e.clone()).font(font(14.0, 400.0)).color(t.c.destructive).wrap().align(rune::Align::Center).w_full());
            let st = font(14.0, 500.0);
            return col().key("lib-detail-error").w_full().padding(t.pad()).child(
                col()
                    .w_full()
                    .padding(40.0)
                    .items_center()
                    .child(banner)
                    .child(crate::ui::exact(text("TIDAL album unavailable.").font(st).color(t.c.foreground), st.line_height)),
            );
        }
        let mut s = loading_sleeve("TIDAL Album", "Loading TIDAL album…", admin, TIDAL_LOADING_FACTS);
        s.versions = picker;
        return sleeve::view(app, t, cx, s);
    };
    let tracks = &album.tracks;
    let queued = album.queued_count.unwrap_or(0);
    let can_download = admin && logic::album_download_state(tracks, queued) != AlbumDownloadState::None;
    let library_id = album.library_album_id.clone().filter(|s| !s.is_empty());
    let actions = if can_download {
        download_control(app, t, &album.id, tracks, queued)
    } else if admin && let Some(lib) = library_id.clone() {
        vec![
            sleeve::button("sleeve-open-library", "Open in library", Some(&i::LIBRARY))
                .build(t)
                .on_press(move |app: &mut App| super::open_album(app, EntityTarget::local(&lib))),
        ]
    } else if admin {
        vec![
            sleeve::button("sleeve-nothing", "Nothing to download", Some(&i::DOWNLOAD))
                .disabled(true)
                .build(t)
                .help("Every track here is saved or no longer on TIDAL"),
        ]
    } else {
        Vec::new()
    };
    let details_link = library_id.filter(|_| can_download || !admin).map(|lib| library_link(t, lib));
    let cover = crate::api::media::album_art(&album.id, None, album.cover_url.as_deref(), Some(crate::api::TrackSource::Tidal), None, None);
    let mut list = Vec::new();
    if let Some(e) = d.error.as_ref().or(d.action_error.as_ref()) {
        list.push(error_banner(t, e));
    }
    let names: Vec<String> = d.credits.iter().map(|c| c.name.clone()).collect();
    let track_list = Some(album_tracks(app, t, names));
    sleeve::view(
        app,
        t,
        cx,
        Sleeve {
            kind: "TIDAL Album",
            album: Some(SleeveAlbum {
                title: album.title.clone(),
                cover,
                credits: &d.credits,
                facts: &d.facts,
                saved_hint: TIDAL_SAVED_HINT,
                tracks,
            }),
            loading_label: "Loading TIDAL album…",
            versions: picker,
            actions,
            reserve_actions: admin,
            loading_facts: TIDAL_LOADING_FACTS,
            details_link,
            on_edit: None,
            matches: (d.rows.len(), tracks.len()),
            list,
            track_list,
        },
    )
}

/// `.album-sleeve-link`: a quiet link to the release's library copy.
fn library_link(t: &Theme, lib: String) -> El {
    row()
        .key("sleeve-library-link")
        .gap(6.0)
        .items_center()
        .role("button")
        .cursor(Cursor::Pointer)
        .hover_group()
        .child(ico(&i::LIBRARY, 14.0, t.c.muted_foreground).group_color(t.c.foreground))
        .child(text("Open in library").font(font(13.0, 500.0)).color(t.c.muted_foreground).group_color(t.c.foreground))
        .on_press(move |app: &mut App| super::open_album(app, EntityTarget::local(&lib)))
}

/// `AlbumDownloadControl` (admin): the whole album or what's missing, and
/// while tracks are queued their count with a cancel button.
fn download_control(app: &App, t: &Theme, tidal_id: &str, tracks: &[TrackListItem], queued: u32) -> Vec<El> {
    let busy = app.pages.library.detail.busy;
    match logic::album_download_state(tracks, queued) {
        AlbumDownloadState::None => Vec::new(),
        AlbumDownloadState::Queued { label, .. } => {
            let id = tidal_id.to_string();
            let mut cancel = iconbtn(t, "sleeve-cancel-download", &i::X, 16.0, BtnState { active: false, disabled: busy })
                .label("Cancel download")
                .help("Cancel download");
            if !busy {
                cancel = cancel.on_press(move |app: &mut App| {
                    let id = id.clone();
                    run(app, move |c| api::tidal::cancel_tidal_album_download(c, &id).map(|_| ()), "Could not cancel the download.")
                });
            }
            vec![sleeve::button("sleeve-download", &label, Some(&i::DOWNLOAD)).disabled(true).build(t), cancel]
        }
        AlbumDownloadState::Available { label, .. } => {
            let id = tidal_id.to_string();
            let mut b = sleeve::button("sleeve-download", &label, Some(&i::DOWNLOAD))
                .disabled(busy)
                .build(t)
                .help("Save these TIDAL tracks into the server library");
            if !busy {
                b = b.on_press(move |app: &mut App| {
                    let id = id.clone();
                    run(app, move |c| api::tidal::download_tidal_album(c, &id).map(|_| ()), "Could not start the album download.")
                });
            }
            vec![b]
        }
    }
}

/// A download or cancel: busy while it's out, then a quiet refetch, or the
/// failure under the column.
fn run(app: &mut App, action: impl FnOnce(&crate::api::Client) -> crate::api::ApiResult<()> + Send + 'static, failure: &'static str) {
    let Some(client) = app.client.clone() else { return };
    let key = app.pages.library.detail.key.clone();
    app.pages.library.detail.busy = true;
    app.net.run(
        move || action(&client),
        move |app, result| {
            if app.pages.library.detail.key != key {
                return;
            }
            app.pages.library.detail.busy = false;
            match result {
                Ok(()) => refresh(app),
                Err(e) => app.pages.library.detail.action_error = Some(error_message(&e, failure)),
            }
        },
    );
}

/// `ReleaseVersionPicker`: segments that share the column, a menu past three.
fn version_picker(app: &App, t: &Theme, cx: &mut Cx<App>, versions: &[ArtistRelease], current: &str, artist: &str) -> El {
    let labels = logic::release_version_labels(versions);
    let options: Vec<(String, String, String)> = versions
        .iter()
        .zip(labels)
        .map(|(v, l)| (api::search::search_entity_id(&v.id, v.source, v.source_id.as_deref()), l.label, l.description))
        .collect();
    if options.len() > 3 {
        let opts: Vec<SelectOption> = options
            .iter()
            .map(|(v, l, d)| SelectOption { title: Some(d.clone()), ..SelectOption::new(v.clone(), l.clone()) })
            .collect();
        return select(app, t, "sleeve-versions", &opts, current, SelectVariant::Outlined, "", false, |app, v| {
            let artist = app.location().get("tidalArtist").map(str::to_string).or_else(|| {
                app.pages.library.detail.tidal_album.as_ref().and_then(|a| a.artist_id.clone())
            });
            if let Some(a) = artist {
                super::open_version(app, v, &a);
            }
        });
    }
    // Each segment takes its label's width plus an equal share of the rest
    // (`flex: 1 1 auto`), across the column (or its own width, stacked).
    let column = cx.layout_size("sleeve-versions").map(|s| s[0]);
    let label_style = font(14.0, 500.0);
    let natural: Vec<f32> = options.iter().map(|(_, l, _)| rune::text::measure(l, &[], label_style, None).0 + 18.0).collect();
    let mut group = row().key("sleeve-versions").w_full().h(32.0).padding(3.0).items_center().radius(t.radius_lg()).fill(t.c.muted).role("tablist").label("Version");
    let free = column.map_or(0.0, |w| (w - 6.0 - natural.iter().sum::<f32>()).max(0.0)) / options.len() as f32;
    for (n, ((value, label, description), w)) in options.into_iter().zip(natural).enumerate() {
        let active = value == current;
        let artist = artist.to_string();
        let v = value.clone();
        let mut b = el()
            .key(format!("sleeve-versions-{n}"))
            .h_full()
            .w(w + free)
            .radius(t.radius_md())
            .items_center()
            .justify_center()
            .role("tab")
            .checked(active)
            .help(description)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .on_press(move |app: &mut App| super::open_version(app, &v, &artist));
        if active {
            b = b.child(crate::ui::kit::segment_indicator(t, "sleeve-versions-indicator"));
        }
        let ink = if active { t.c.foreground } else { t.c.muted_foreground };
        b = b.child(text(label).font(label_style).color(ink).group_color(t.c.foreground));
        if !active {
            b = b.hover_group().press_scale(0.97);
        }
        group = group.child(b);
    }
    group
}
