//! `ArtistDetail.tsx` (`artist.css`): a library artist's page (hero, play
//! and shuffle, track search, discography, songs) and a TIDAL artist's
//! (popular tracks, folded discography, retry on failure).

use rune::{Color, Cursor, Cx, El, col, el, row, text};

use crate::api::TrackListItem;
use crate::app::App;
use crate::format::display_text;
use crate::shell::{Bp, window_size};
use crate::theme::{Theme, color_mix};
use crate::ui::forms::search_input_with;
use crate::ui::kit::{empty_state, error_banner, loading_state};
use crate::ui::{self, Btn, css_border, font, ico, icons as i, motion, tnum, with_lh};

use super::adapters::{self, TableOptions};
use super::album::{filtered, not_found};
use super::cards;
use super::logic::{self, ArtistRelease, RELEASE_FILTER_OPTIONS};
use super::requests::{self, error_message};
use super::sleeve::{balanced_width, clear_on_escape, skeleton};

const SHELF_LIMIT: usize = 6;

// ---------------------------------------------------------------- loading

pub fn enter_library(app: &mut App, id: &str) {
    if super::mount(app, format!("artist:{id}"), id) {
        let s = &mut app.pages.library;
        if let Some((a, t)) = s.cache.artists.get(id).cloned() {
            s.detail.artist = Some(a);
            s.detail.tracks = Some(t);
        }
    }
    let Some(client) = app.client.clone() else { return };
    let d = &mut app.pages.library.detail;
    d.seq += 1;
    let (seq, key, id) = (d.seq, d.key.clone(), d.id.clone());
    app.net.run(
        move || requests::get_artist(&client, &id),
        move |app, result| {
            let s = &mut app.pages.library;
            if s.detail.seq != seq || s.detail.key != key {
                return;
            }
            match result {
                Ok((artist, tracks)) => {
                    s.cache.artists.insert(s.detail.id.clone(), (artist.clone(), tracks.clone()));
                    s.detail.artist = Some(artist);
                    s.detail.tracks = Some(tracks);
                    s.detail.error = None;
                }
                Err(e) if e.status == 404 => {
                    s.cache.artists.remove(&s.detail.id);
                    s.detail.not_found = true;
                }
                Err(e) => s.detail.error = Some(error_message(&e, "Failed to load artist.")),
            }
        },
    );
}

pub fn enter_tidal(app: &mut App, id: &str) {
    if super::mount(app, format!("tidal-artist:{id}"), id) {
        let s = &mut app.pages.library;
        s.detail.tidal_artist = s.cache.tidal_artists.get(id).cloned();
    }
    load_tidal(app);
}

fn load_tidal(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let d = &mut app.pages.library.detail;
    d.seq += 1;
    let (seq, key, id, attempt) = (d.seq, d.key.clone(), d.id.clone(), d.attempt);
    app.net.run(
        move || requests::get_tidal_artist(&client, &id),
        move |app, result| {
            let s = &mut app.pages.library;
            if s.detail.seq != seq || s.detail.key != key {
                return;
            }
            s.detail.completed = Some(attempt);
            match result {
                Ok(artist) => {
                    s.cache.tidal_artists.insert(s.detail.id.clone(), artist.clone());
                    s.detail.tidal_artist = Some(artist);
                }
                Err(e) => {
                    if e.status == 404 {
                        s.cache.tidal_artists.remove(&s.detail.id);
                        s.detail.tidal_artist = None;
                    }
                    s.detail.error = Some(error_message(&e, "Couldn't load artist."));
                }
            }
        },
    );
}

fn retry(app: &mut App) {
    let d = &mut app.pages.library.detail;
    d.error = None;
    d.attempt += 1;
    load_tidal(app);
}

// ---------------------------------------------------------------- pieces

/// The page's content width.
fn content_width(t: &Theme, cx: &mut Cx<App>) -> f32 {
    cx.layout_size("artist-page").map_or(956.0, |s| s[0] - 2.0 * t.pad())
}

/// `ArtistHero`. `name` is None while loading (a bar in its place).
fn hero(app: &App, t: &Theme, width: f32, name: Option<&str>, image: Option<String>, tidal: bool, meta: Option<Vec<String>>) -> El {
    // The hero is its own container (`container-type: inline-size`).
    let cw = width - 2.0 * 24.0 - 2.0;
    let narrow = cw <= 560.0;
    let name_size = if cw >= 860.0 {
        60.0
    } else if cw >= 690.0 {
        48.0
    } else if cw >= 520.0 {
        36.0
    } else {
        30.0
    };
    let avatar = if narrow { 132.0 } else { (cw * 0.22).clamp(120.0, 192.0) };
    let art = match name {
        Some(n) => ui::cover_art(t, &app.images, image.as_deref(), n, avatar, avatar, 999.0),
        None => el().size(avatar, avatar).radius(999.0).fill(t.c.muted),
    };
    let body_w = if narrow { cw } else { cw - avatar - 24.0 };
    let mut kind = row().gap(8.0).items_center().child(text("Artist").font(font(12.0, 500.0)).color(t.c.muted_foreground));
    if tidal {
        kind = kind.child(adapters::badge(t, "TIDAL"));
    }
    let style = with_lh(font(name_size, 600.0), (name_size * 1.05 * 100.0).round() / 100.0).tracking(-0.025 * name_size);
    let title = match name {
        Some(n) => {
            let shown = display_text(Some(n), "");
            let w = balanced_width(&shown, style, body_w);
            text(shown).font(style).color(t.c.foreground).wrap_anywhere().w(w).role("heading")
        }
        None => el().h(style.line_height).items_center().child(skeleton(t, 360.0f32.min(body_w * 0.7).floor(), name_size)),
    };
    let mut meta_row = row().flex_wrap().gaps(4.0, 8.0).items_center();
    let items: Vec<String> = meta.unwrap_or_default().into_iter().filter(|m| !m.is_empty()).collect();
    if items.is_empty() {
        meta_row = meta_row.child(text("\u{a0}").font(font(14.0, 400.0)).color(t.c.muted_foreground));
    }
    for (n, m) in items.into_iter().enumerate() {
        let mut part = row().gap(8.0).items_center();
        if n > 0 {
            part = part.child(el().size(3.0, 3.0).radius(99.0).fill(t.c.muted_foreground));
        }
        meta_row = meta_row.child(part.child(text(m).font(font(14.0, 400.0)).color(t.c.muted_foreground)));
    }
    let body = col().w(body_w).min_w(0.0).pb(4.0).child(kind).child(title.mt(8.0).mb(12.0)).child(meta_row);
    let main = if narrow {
        col().gap(18.0).items_start().child(art).child(body)
    } else {
        row().gap(24.0).items_end().child(art).child(body)
    };
    css_border(col(), 1.0, t.c.border, t.radius_xl())
        .key("artist-hero")
        .w_full()
        .min_h(280.0)
        .padding(25.0)
        .justify_center()
        .radius(t.radius_xl())
        .fill(t.c.card)
        .clip_rounded(t.radius_xl())
        .child(main)
}

/// `ArtistActions`: play/pause the artist, shuffle, and `end` on the right.
fn actions(app: &App, t: &Theme, name: &str, tracks: &[TrackListItem], end: Option<El>, wrap_end: bool) -> El {
    let (here, show_pause, can_play) = logic::list_playback_state(tracks, app.player.current(), app.player.playing);
    let label = display_text(Some(name), "");
    let queue = tracks.to_vec();
    let hot = color_mix(t.c.primary, 0.8, Color::TRANSPARENT);
    let mut play = el()
        .key("artist-play")
        .size(40.0, 40.0)
        .radius(999.0)
        .fill(t.c.primary)
        .center()
        .role("button")
        .label(if show_pause { format!("Pause {label}") } else { format!("Play {label}") })
        .child(ico(if show_pause { &i::PAUSE_FILLED } else { &i::PLAY_FILLED }, 24.0, t.c.primary_foreground));
    if can_play {
        play = play
            .cursor(Cursor::Pointer)
            .focusable(true)
            .hover(ui::hover_overlay(t.c.primary, hot))
            .press_scale(0.97)
            .on_press(move |app: &mut App| {
                if here {
                    app.player.toggle_play();
                } else {
                    logic::start_list_playback(&mut app.player, &queue);
                }
            });
    } else {
        play = play.opacity(0.5).disabled(true).cursor(Cursor::NotAllowed);
    }
    let on = app.player.shuffle;
    let ink = if on { t.c.foreground } else { t.c.muted_foreground };
    let mut shuffle = el()
        .key("artist-shuffle")
        .size(32.0, 32.0)
        .radius(t.radius_lg())
        .center()
        .role("button")
        .label("Shuffle")
        .checked(on)
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(t.c.ghost_hover)
        .hover_motion(motion::ease(120.0), motion::ease(120.0))
        .on_press(|app: &mut App| app.player.toggle_shuffle())
        .child(ico(&i::SHUFFLE, 20.0, ink).group_color(t.c.foreground));
    if on {
        shuffle = shuffle.child(el().absolute(14.0, 25.0).size(4.0, 4.0).radius(99.0).fill(t.c.foreground).inert());
    }
    let mut r = row().key("artist-actions").w_full().flex_wrap().gap(12.0).items_center().pt(4.0).px(4.0).child(play).child(shuffle);
    if let Some(e) = end {
        r = if wrap_end { r.child(el().w_full().min_w(0.0).child(e.w_full())) } else { r.child(el().grow(1.0)).child(e) };
    }
    r
}

/// `DetailTrackSearchBar` for an artist.
fn search_bar(app: &App, t: &Theme, total: usize, matches: usize, full: bool) -> El {
    let edit = &app.pages.library.detail.search;
    let active = !edit.text.trim().is_empty();
    let field = search_input_with(t, "artist-search", edit, "Search this artist", if full { None } else { Some(260.0) }, |f| {
        f.on_edit(|app: &mut App| &mut app.pages.library.detail.search).on_input_key(clear_on_escape)
    })
    .fill(t.c.background);
    let mut r = row().gap(12.0).items_center().justify_end();
    if active {
        r = r.child(text(format!("{matches} of {total} match")).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground));
    }
    r.child(if full { field.grow(1.0) } else { field })
}

/// `.artist-more`: "See more", "Show all", and their undo.
fn more_button(t: &Theme, key: &str, label: &str, on_press: fn(&mut App)) -> El {
    row()
        .key(key.to_string())
        .h(28.0)
        .px(10.0)
        .items_center()
        .radius(t.radius_lg())
        .role("button")
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(Color::TRANSPARENT)
        .child(text(label.to_string()).font(font(14.0, 500.0)).color(t.c.muted_foreground).group_color(t.c.foreground))
        .on_press(on_press)
}

/// `.chip`.
fn chip(t: &Theme, key: String, label: &str, active: bool, on_press: impl Fn(&mut App) + 'static) -> El {
    let mut c = css_border(row(), 1.0, t.c.input, t.radius_lg())
        .key(key)
        .h(28.0)
        .px(11.0)
        .items_center()
        .radius(t.radius_lg())
        .role("button")
        .checked(active)
        .cursor(Cursor::Pointer)
        .press_scale(0.97)
        .child(text(label.to_string()).font(font(14.0, 500.0)).color(t.c.foreground))
        .on_press(on_press);
    c = if active { c.fill(t.c.muted) } else { c.hover(t.c.muted) };
    c
}

/// `Discography`: filter chips, then a shelf (or every release in a grid).
fn discography(app: &App, t: &Theme, releases: &[ArtistRelease], width: f32) -> El {
    let d = &app.pages.library.detail;
    let shown = logic::filter_releases(releases, d.filter);
    let action = (shown.len() > SHELF_LIMIT).then(|| {
        more_button(t, "artist-show-all", if d.show_all { "Show less" } else { "Show all" }, |app| {
            let d = &mut app.pages.library.detail;
            d.show_all = !d.show_all;
        })
    });
    let mut body = Vec::new();
    if logic::has_release_filters(releases) {
        let mut chips = row().gap(8.0).flex_wrap().mb(12.0);
        for (value, label) in RELEASE_FILTER_OPTIONS {
            chips = chips.child(chip(t, format!("artist-chip-{label}"), label, d.filter == value, move |app| {
                app.pages.library.detail.filter = value;
            }));
        }
        body.push(chips);
    }
    if d.show_all {
        let list: Vec<Box<dyn FnOnce(f32) -> El + '_>> = shown
            .iter()
            .enumerate()
            .map(|(n, r)| -> Box<dyn FnOnce(f32) -> El + '_> {
                let r = r.clone();
                Box::new(move |w| cards::release_card(app, t, &format!("release-{n}"), &r, w))
            })
            .collect();
        body.push(cards::grid(t, "artist-releases", width, list));
    } else {
        let list: Vec<El> = shown.iter().enumerate().map(|(n, r)| cards::release_card(app, t, &format!("release-{n}"), r, 168.0)).collect();
        body.push(adapters::shelf(t, "artist-shelf", "Discography", list));
    }
    adapters::section(t, "artist-discography", "Discography", action, body).mt(16.0)
}

// ---------------------------------------------------------------- views

pub fn view_library(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let d = &app.pages.library.detail;
    if d.not_found {
        return not_found(t, "Artist");
    }
    let width = content_width(t, cx);
    let page = col().key("artist-page").w_full().padding(t.pad()).gap(16.0);
    let (Some(artist), Some(tracks)) = (&d.artist, &d.tracks) else {
        if let Some(e) = &d.error {
            return page.gap(10.0).child(error_banner(t, e));
        }
        return page
            .role("status")
            .child(hero(app, t, width, None, None, false, Some(vec!["Loading artist…".into()])))
            .child(actions(app, t, "", &[], None, false));
    };
    let wrap = Bp::of(window_size(cx)[0]) != Bp::Wide && window_size(cx)[0] <= 900.0;
    let (rows, query) = filtered(app, tracks);
    let image = logic::artist_image_url(None, tracks, None);
    let meta = logic::artist_meta_parts(artist.track_count, artist.album_count, None);
    let mut v = page
        .child(hero(app, t, width, Some(&artist.name), image, false, Some(meta)))
        .child(actions(app, t, &artist.name, tracks, Some(search_bar(app, t, tracks.len(), rows.len(), wrap)), wrap));
    if let Some(e) = &d.error {
        v = v.child(error_banner(t, e));
    }
    let releases = logic::library_artist_releases(tracks);
    if query.is_none() && !releases.is_empty() {
        v = v.child(discography(app, t, &releases, width));
    }
    let empty = query.as_deref().map(|q| empty_state(t, None, "No matches.", Some(&format!("Nothing by this artist matches \"{q}\".")), None));
    let table = adapters::track_table(app, t, "artist-table", &rows, tracks, &TableOptions { width, ..TableOptions::default() }, empty);
    v.child(adapters::section(t, "artist-songs", "Songs", None, vec![table]).mt(16.0))
}

pub fn view_tidal(app: &App, t: &Theme, cx: &mut Cx<App>, name_param: &str) -> El {
    let d = &app.pages.library.detail;
    let width = content_width(t, cx);
    let data = d.tidal_artist.as_ref();
    let loading = d.completed != Some(d.attempt);
    let warning = data.and_then(|a| a.warnings.as_ref()).map(|w| w.join(" ")).filter(|w| !w.is_empty());
    let tracks: &[TrackListItem] = data.map_or(&[], |a| a.tracks());
    let releases = data.map(|a| logic::fold_release_versions(&logic::tidal_artist_releases(a.albums()))).unwrap_or_default();
    let profile = data.and_then(|a| a.artist.as_ref());
    let name = profile.map(|p| p.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| name_param.to_string());
    let image = logic::artist_image_url(profile.and_then(|p| p.cover_url.as_deref()), tracks, None);
    let meta = data.map(|_| logic::tidal_artist_meta_parts(releases.len(), tracks.len()));
    let mut v = col()
        .key("artist-page")
        .w_full()
        .padding(t.pad())
        .gap(16.0)
        .child(hero(app, t, width, Some(&name), image, true, meta))
        .child(actions(app, t, &name, tracks, None, false));
    if d.error.is_some() || warning.is_some() {
        let mut status = col().w_full().gap(10.0);
        if let Some(e) = &d.error {
            status = status.child(error_banner(t, e));
        }
        if let Some(w) = &warning {
            status = status.child(error_banner(t, w));
        }
        let b = Btn::new("artist-retry", if loading { "Retrying…" } else { "Retry artist" }).disabled(loading).build(t);
        status = status.child(row().child(if loading { b } else { b.on_press(retry) }));
        v = v.child(status);
    }
    if data.is_none() && loading {
        v = v.child(loading_state(t, "Loading artist…"));
    }
    if data.is_some() {
        if !tracks.is_empty() {
            v = v.child(popular(app, t, tracks, width));
        }
        if !releases.is_empty() {
            v = v.child(discography(app, t, &releases, width));
        }
        if releases.is_empty() && tracks.is_empty() && warning.is_none() && d.error.is_none() && !loading {
            v = v.child(empty_state(t, None, "No releases found.", None, None));
        }
    }
    v
}

/// `PopularTracks`: the first five, then the rest behind "See more".
fn popular(app: &App, t: &Theme, tracks: &[TrackListItem], width: f32) -> El {
    let expanded = app.pages.library.detail.popular_expanded;
    let shown = if expanded { tracks } else { &tracks[..tracks.len().min(logic::ARTIST_POPULAR_PREVIEW_COUNT)] };
    let opts = TableOptions { show_header: false, selectable: false, show_source_badge: false, width, ..TableOptions::default() };
    let mut body = vec![adapters::track_table(app, t, "artist-popular", shown, tracks, &opts, None)];
    if tracks.len() > logic::ARTIST_POPULAR_PREVIEW_COUNT {
        body.push(
            row()
                .mt(6.0)
                .child(more_button(t, "artist-see-more", if expanded { "Show less" } else { "See more" }, |app| {
                    let d = &mut app.pages.library.detail;
                    d.popular_expanded = !d.popular_expanded;
                })),
        );
    }
    adapters::section(t, "artist-popular-section", "Popular", None, body).mt(16.0)
}
