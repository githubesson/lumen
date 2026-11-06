//! `LibraryDetail.tsx`'s album pages (`AlbumDetailView`,
//! `TidalAlbumDetailView`, `NotFound`), `ReleaseVersionPicker.tsx`,
//! `useReleaseVersions.ts` and `AlbumDownloadControl.tsx`.

use std::time::Duration;

use rune::{Color, Cursor, Cx, El, Shadow, col, el, row, text};

use crate::api::TrackListItem;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::{SelectOption, SelectVariant, select};
use crate::ui::kit::{empty_state, error_banner};
use crate::ui::{Btn, BtnState, font, ico, icons as i, iconbtn};

use super::adapters::{self, Host, TableOptions};
use super::logic::{self, AlbumDownloadState, ArtistRelease, CreditFields, EntityTarget};
use super::requests::{self, error_message};
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
    }
    load_library(app, false);
}

/// Read the album and its tracks; `quiet` refreshes keep the page on failure.
fn load_library(app: &mut App, quiet: bool) {
    let Some(client) = app.client.clone() else { return };
    let d = &mut app.pages.library.detail;
    d.seq += 1;
    let (seq, key, id) = (d.seq, d.key.clone(), d.id.clone());
    app.net.run(
        move || requests::get_album(&client, &id),
        move |app, result| {
            let s = &mut app.pages.library;
            if s.detail.seq != seq || s.detail.key != key {
                return;
            }
            match result {
                Ok((album, tracks)) => {
                    s.cache.albums.insert(s.detail.id.clone(), (album.clone(), tracks.clone()));
                    let queued = album.queued_count.unwrap_or(0);
                    s.detail.album = Some(album);
                    s.detail.tracks = Some(tracks);
                    s.detail.error = None;
                    if queued > 0 {
                        arm_refresh(app);
                    }
                }
                Err(_) if quiet => {}
                Err(e) if e.status == 404 => {
                    s.cache.albums.remove(&s.detail.id);
                    s.detail.not_found = true;
                }
                Err(e) => s.detail.error = Some(error_message(&e, "Failed to load album.")),
            }
        },
    );
}

/// `TidalAlbumDetailView`'s mount.
pub fn enter_tidal(app: &mut App, id: &str, artist: Option<&str>) {
    if super::mount(app, format!("tidal-album:{id}"), id) {
        let s = &mut app.pages.library;
        s.detail.tidal_album = s.cache.tidal_albums.get(id).cloned();
    }
    load_tidal(app, false);
    let artist = artist.map(str::to_string).or_else(|| app.pages.library.detail.tidal_album.as_ref().and_then(|a| a.artist_id.clone()));
    if let Some(a) = artist {
        ensure_versions(app, &a);
    }
}

fn load_tidal(app: &mut App, quiet: bool) {
    let Some(client) = app.client.clone() else { return };
    let d = &mut app.pages.library.detail;
    d.seq += 1;
    let (seq, key, id) = (d.seq, d.key.clone(), d.id.clone());
    app.net.run(
        move || requests::get_tidal_album(&client, &id),
        move |app, result| {
            let s = &mut app.pages.library;
            if s.detail.seq != seq || s.detail.key != key {
                return;
            }
            match result {
                Ok(album) => {
                    s.cache.tidal_albums.insert(s.detail.id.clone(), album.clone());
                    let queued = album.queued_count.unwrap_or(0);
                    let artist = album.artist_id.clone();
                    s.detail.tidal_album = Some(album);
                    if quiet {
                        s.detail.error = None;
                    }
                    if queued > 0 {
                        arm_refresh(app);
                    }
                    let from_url = app.location().get("tidalArtist").is_some_and(|a| !a.is_empty());
                    if let Some(a) = artist.filter(|_| !from_url) {
                        ensure_versions(app, &a);
                    }
                }
                Err(_) if quiet => {}
                Err(e) => {
                    // Gone from TIDAL: don't keep showing (or caching) the old copy.
                    if e.status == 404 {
                        s.cache.tidal_albums.remove(&s.detail.id);
                        s.detail.tidal_album = None;
                    }
                    s.detail.error = Some(error_message(&e, "Failed to load TIDAL album."));
                }
            }
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
            move || requests::get_tidal_artist(&client, &id)
        },
        move |app, result| {
            let c = &mut app.pages.library.cache;
            c.fetching.remove(&id);
            if let Ok(artist) = result {
                c.tidal_artists.insert(id, artist);
            }
        },
    );
}

fn versions(app: &App, artist_id: &str, id: &str) -> Option<Vec<ArtistRelease>> {
    let artist = app.pages.library.cache.tidal_artists.get(artist_id)?;
    logic::release_versions_of(&logic::tidal_artist_releases(artist.albums()), id)
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

/// The search's matches (`useDetailTrackSearch`).
pub fn filtered<'a>(app: &App, tracks: &'a [TrackListItem]) -> (Vec<TrackListItem>, Option<String>) {
    let q = app.pages.library.detail.search.text.clone();
    let needle = q.trim().to_lowercase();
    if needle.is_empty() {
        return (tracks.to_vec(), None);
    }
    (tracks.iter().filter(|t| logic::track_search_key(t).contains(&needle)).cloned().collect(), Some(q))
}

/// `AlbumTrackList`: no row covers or albums, and rows crediting only the
/// album's artists leave their artist line out.
fn album_tracks(
    app: &App,
    t: &Theme,
    cx: &mut Cx<App>,
    rows: &[TrackListItem],
    queue: &[TrackListItem],
    credits: Vec<String>,
    query: Option<&str>,
) -> El {
    let opts = TableOptions {
        show_cover: false,
        show_album: false,
        omit_artists: credits,
        host: Some(Host::AlbumTools),
        min_width: 0.0,
        width: sleeve::list_width(t, cx),
        ..TableOptions::default()
    };
    let empty = query.map(|q| empty_state(t, None, "No matches.", Some(&format!("Nothing in this album matches \"{q}\".")), None));
    adapters::track_table(app, t, "album-table", rows, queue, &opts, empty)
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
            .child(super::exact(text(format!("{kind} not found.")).font(font(14.0, 500.0)).color(t.c.foreground), font(14.0, 500.0), 1))
            .child(
                super::exact(
                    text("It may have been removed or renamed.").font(font(14.0, 400.0)).color(t.c.muted_foreground),
                    font(14.0, 400.0),
                    1,
                )
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
            adapters::edit_album(app, &a);
        }
    });
    let (Some(album), Some(tracks)) = (&d.album, &d.tracks) else {
        if let Some(e) = &d.error {
            return load_error(t, e);
        }
        return sleeve::view(app, t, cx, loading_sleeve("Album", "Loading album…", false, LOADING_FACTS));
    };
    let credits = logic::album_credits(&CreditFields {
        artist_id: album.artist_id.as_deref(),
        artist_has_page: album.artist_has_page,
        artist_name: album.artist_name.as_deref(),
        artist_names: &album.artist_names,
        ..Default::default()
    });
    let nonce = (d.cover_nonce > 0).then(|| d.cover_nonce.to_string());
    let cover = crate::api::media::album_art(&album.id, Some(album.has_cover), None, None, None, nonce.as_deref());
    let (rows, query) = filtered(app, tracks);
    let mut list = Vec::new();
    if let Some(e) = d.error.as_ref().or(d.action_error.as_ref()) {
        list.push(error_banner(t, e));
    }
    let names: Vec<String> = credits.iter().map(|c| c.name.clone()).collect();
    list.push(album_tracks(app, t, cx, &rows, tracks, names, query.as_deref()));
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
                credits,
                facts: logic::library_album_facts(album, tracks),
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
            matches: (rows.len(), tracks.len()),
            list,
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
    }
}

pub fn view_tidal(app: &App, t: &Theme, cx: &mut Cx<App>, id: &str, artist_param: Option<&str>) -> El {
    let d = &app.pages.library.detail;
    let admin = is_admin(app);
    let versions_artist = artist_param.map(str::to_string).or_else(|| d.tidal_album.as_ref().and_then(|a| a.artist_id.clone()));
    let picker = versions_artist
        .as_deref()
        .and_then(|artist| versions(app, artist, id).map(|v| version_picker(app, t, cx, &v, id, artist)));
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
                    .child(super::exact(text("TIDAL album unavailable.").font(st).color(t.c.foreground), st, 1)),
            );
        }
        let mut s = loading_sleeve("TIDAL Album", "Loading TIDAL album…", admin, TIDAL_LOADING_FACTS);
        s.versions = picker;
        return sleeve::view(app, t, cx, s);
    };
    let tracks = album.tracks();
    let queued = album.queued_count.unwrap_or(0);
    let can_download = admin && logic::album_download_state(tracks, queued) != AlbumDownloadState::None;
    let library_id = album.library_album_id.clone().filter(|s| !s.is_empty());
    let actions = if can_download {
        download_control(app, t, &album.id, tracks, queued)
    } else if admin && let Some(lib) = library_id.clone() {
        vec![
            sleeve::button("sleeve-open-library", "Open in library", Some(&i::LIBRARY))
                .build(t)
                .on_press(move |app: &mut App| super::open_album(app, EntityTarget::Local(lib.clone()))),
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
    let credits = logic::album_credits(&CreditFields {
        artist_names: album.artists.as_deref().unwrap_or(&[]),
        artist: album.artist.as_deref(),
        ..Default::default()
    });
    let cover = crate::api::media::album_art(&album.id, None, album.cover_url.as_deref(), Some(crate::api::TrackSource::Tidal), None, None);
    let (rows, query) = filtered(app, tracks);
    let mut list = Vec::new();
    if let Some(e) = d.error.as_ref().or(d.action_error.as_ref()) {
        list.push(error_banner(t, e));
    }
    let names: Vec<String> = credits.iter().map(|c| c.name.clone()).collect();
    list.push(album_tracks(app, t, cx, &rows, tracks, names, query.as_deref()));
    sleeve::view(
        app,
        t,
        cx,
        Sleeve {
            kind: "TIDAL Album",
            album: Some(SleeveAlbum {
                title: album.title.clone(),
                cover,
                credits,
                facts: logic::tidal_album_facts(album.saved_count, album.release_year, tracks),
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
            matches: (rows.len(), tracks.len()),
            list,
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
        .hover(Color::TRANSPARENT)
        .child(ico(&i::LIBRARY, 14.0, t.c.muted_foreground).group_color(t.c.foreground))
        .child(text("Open in library").font(font(13.0, 500.0)).color(t.c.muted_foreground).group_color(t.c.foreground))
        .on_press(move |app: &mut App| super::open_album(app, EntityTarget::Local(lib.clone())))
}

/// `AlbumDownloadControl` (admin): the whole album or what's missing, and
/// while tracks are queued their count with a cancel button.
fn download_control(app: &App, t: &Theme, tidal_id: &str, tracks: &[TrackListItem], queued: u32) -> Vec<El> {
    let busy = app.pages.library.detail.busy;
    match logic::album_download_state(tracks, queued) {
        AlbumDownloadState::None => Vec::new(),
        AlbumDownloadState::Queued { label } => {
            let id = tidal_id.to_string();
            let mut cancel = iconbtn(t, "sleeve-cancel-download", &i::X, 16.0, BtnState { active: false, disabled: busy })
                .label("Cancel download")
                .help("Cancel download");
            if !busy {
                cancel = cancel.on_press(move |app: &mut App| {
                    let id = id.clone();
                    run(app, move |c| requests::cancel_tidal_album_download(c, &id), "Could not cancel the download.")
                });
            }
            vec![sleeve::button("sleeve-download", &label, Some(&i::DOWNLOAD)).disabled(true).build(t), cancel]
        }
        AlbumDownloadState::Available { label } => {
            let id = tidal_id.to_string();
            let mut b = sleeve::button("sleeve-download", &label, Some(&i::DOWNLOAD))
                .disabled(busy)
                .build(t)
                .help("Save these TIDAL tracks into the server library");
            if !busy {
                b = b.on_press(move |app: &mut App| {
                    let id = id.clone();
                    run(app, move |c| requests::download_tidal_album(c, &id), "Could not start the album download.")
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
        .map(|(v, l)| (logic::search_entity_id(&v.id, v.source, v.source_id.as_deref()), l.label, l.description))
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
            .cursor(Cursor::Pointer)
            .on_press(move |app: &mut App| super::open_version(app, &v, &artist));
        if active {
            let mut pill = el()
                .key("sleeve-versions-indicator")
                .matched("sleeve-versions-indicator")
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .radius(t.radius_md())
                .motion(rune_motion::Spring::new(0.2, 0.0));
            if t.dark() {
                pill = pill.fill(t.c.input_bg).border(1.0, t.c.input);
            } else {
                pill = pill
                    .fill(t.c.background)
                    .box_shadow(Shadow { x: 0.0, y: 1.0, blur: 3.0, spread: 0.0, color: Color::BLACK.alpha(0.1), inset: false })
                    .box_shadow(Shadow { x: 0.0, y: 1.0, blur: 2.0, spread: -1.0, color: Color::BLACK.alpha(0.1), inset: false });
            }
            b = b.child(pill);
        }
        let ink = if active { t.c.foreground } else { t.c.muted_foreground };
        b = b.child(text(label).font(label_style).color(ink).group_color(t.c.foreground));
        if !active {
            b = b.hover(Color::TRANSPARENT).press_scale(0.97);
        }
        group = group.child(b);
    }
    group
}
