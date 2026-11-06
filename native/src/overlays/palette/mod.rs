//! `CommandPalette.tsx` (`command-palette.css`): cmdk's dialog. Search the
//! library (one entity type at a time, a short preview the library page
//! continues), jump to a page or playlist, drive playback and run commands.
//! Arrows move the highlight (wrapping), Enter runs it, Escape closes.
//! While the query is under two characters, cmdk filters and ranks the
//! commands by its fuzzy score; from two on, the server's results show and
//! everything else stays in place.
pub mod score;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use rune::{Color, Cursor, Cx, El, Icon, Key, KeyEvent, Shadow, TextEdit, Tx, col, el, row, text};

use crate::api::{SearchAlbum, SearchArtist, TrackListItem, TrackSource, media};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::kit::{SegSize, scroll_area_fit, segmented_sized};
use crate::ui::{cover_art, css_border, css_border_bottom, font, ico, icons as i, line, tnum};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SearchType {
    #[default]
    All,
    Track,
    Album,
    Artist,
}

impl SearchType {
    pub fn as_str(self) -> &'static str {
        match self {
            SearchType::All => "all",
            SearchType::Track => "track",
            SearchType::Album => "album",
            SearchType::Artist => "artist",
        }
    }
    /// `SEARCH_PLACEHOLDER_NOUN`.
    fn noun(self) -> &'static str {
        match self {
            SearchType::All => "music",
            SearchType::Track => "songs",
            SearchType::Album => "albums",
            SearchType::Artist => "artists",
        }
    }
}

/// `SEARCH_TYPE_OPTIONS`.
const SEARCH_TYPES: &[(SearchType, &str)] =
    &[(SearchType::All, "All"), (SearchType::Track, "Songs"), (SearchType::Album, "Albums"), (SearchType::Artist, "Artists")];

#[derive(Default)]
pub struct State {
    pub query: TextEdit,
    pub search_type: SearchType,
    pub tracks: Vec<TrackListItem>,
    pub albums: Vec<SearchAlbum>,
    pub artists: Vec<SearchArtist>,
    pub loading: bool,
    pub error: Option<String>,
    /// The highlighted item's value; None highlights the first one.
    pub selected: Option<String>,
    /// The newest search; older answers are dropped.
    latest: Arc<AtomicU64>,
}

pub fn is_open(app: &App) -> bool {
    app.ui.palette_open
}

/// Open with a fresh search session and the input focused.
pub fn open(app: &mut App) {
    app.ui.settings_open = false;
    app.ui.palette_open = true;
    let s = &mut app.overlays.palette;
    s.query = TextEdit::new("");
    s.query.focused = true;
    s.search_type = SearchType::All;
    s.tracks.clear();
    s.albums.clear();
    s.artists.clear();
    s.loading = false;
    s.error = None;
    s.selected = None;
    s.latest.fetch_add(1, Ordering::Relaxed);
}

pub fn close(app: &mut App) {
    app.ui.palette_open = false;
    app.overlays.palette.loading = false;
    app.overlays.palette.latest.fetch_add(1, Ordering::Relaxed);
}

/// Ctrl+K.
pub fn toggle(app: &mut App) {
    if app.ui.palette_open { close(app) } else { open(app) }
}

fn searching(s: &State) -> bool {
    s.query.text.trim().chars().count() >= 2
}

/// The query changed (as typing changes it).
pub fn changed(app: &mut App) {
    refresh(app);
}

/// The query changed, or the type did: search again after a 160 ms pause.
fn refresh(app: &mut App) {
    let s = &mut app.overlays.palette;
    s.selected = None;
    let id = s.latest.fetch_add(1, Ordering::Relaxed) + 1;
    let q = s.query.text.trim().to_string();
    if q.chars().count() < 2 {
        s.tracks.clear();
        s.albums.clear();
        s.artists.clear();
        s.error = None;
        s.loading = false;
        return;
    }
    s.error = None;
    s.loading = true;
    // cmdk highlights the first item as the query changes and keeps it while
    // results arrive: mid-search that is "View all results" (the old results
    // can't be picked while it loads).
    let first = {
        let groups = visible(app);
        let flat: Vec<&Item> = groups.iter().flat_map(|g| g.items.iter()).collect();
        current(&app.overlays.palette, &flat)
    };
    let s = &mut app.overlays.palette;
    s.selected = first;
    let kind = s.search_type;
    let limit = if kind == SearchType::All { 8 } else { 20 };
    let latest = s.latest.clone();
    let Some(client) = app.client.clone() else { return };
    let wait = !app.net.is_sync();
    app.net.run(
        move || {
            if wait {
                std::thread::sleep(std::time::Duration::from_millis(160));
            }
            if latest.load(Ordering::Relaxed) != id {
                return None;
            }
            Some(super::requests::search(&client, &q, kind.as_str(), limit))
        },
        move |app, result| {
            let s = &mut app.overlays.palette;
            let Some(result) = result else { return };
            if s.latest.load(Ordering::Relaxed) != id || !app.ui.palette_open {
                return;
            }
            match result {
                Ok(r) => {
                    s.albums = r.albums;
                    s.artists = r.artists;
                    s.tracks = r.tracks;
                    s.error = (!r.warnings.is_empty()).then(|| r.warnings.join(" "));
                }
                Err(e) => {
                    // A failed query must not bring back the previous query's results.
                    s.tracks.clear();
                    s.albums.clear();
                    s.artists.clear();
                    s.error = Some(super::error_message(&e, "Search failed."));
                }
            }
            s.loading = false;
        },
    );
}

fn pick_type(app: &mut App, kind: SearchType) {
    let s = &mut app.overlays.palette;
    s.search_type = kind;
    s.query.focused = true;
    refresh(app);
}

#[derive(Clone)]
enum Lead {
    Icon(&'static Icon),
    Cover { url: Option<String>, label: String, round: bool },
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Command {
    PlayPause,
    Next,
    Prev,
    Shuffle,
    Repeat,
    Theme,
    Settings,
    Upload,
    SignOut,
}

#[derive(Clone, Debug, PartialEq)]
enum Act {
    Go(String),
    Play(usize),
    Run(Command),
}

#[derive(Clone)]
struct Item {
    /// cmdk's `value`: what the filter scores, and the item's identity.
    value: String,
    lead: Lead,
    title: String,
    sub: Option<String>,
    hint: Option<String>,
    disabled: bool,
    act: Act,
}

struct Group {
    heading: Option<&'static str>,
    items: Vec<Item>,
}

fn icon_item(value: String, glyph: &'static Icon, title: &str, hint: Option<String>, act: Act) -> Item {
    Item { value, lead: Lead::Icon(glyph), title: title.into(), sub: None, hint, disabled: false, act }
}

fn library_href(q: &str, kind: SearchType, rest: &str) -> String {
    format!("/library?q={}&type={}{rest}", urlencoding::encode(q), kind.as_str())
}

/// `albumSubtitle`: "Artist · 12 tracks · TIDAL".
fn album_subtitle(a: &SearchAlbum) -> String {
    let artist = crate::format::display_text(a.album.artist_name.as_deref(), "");
    let artist = if !artist.is_empty() {
        artist
    } else if a.album.is_compilation {
        "Various Artists".into()
    } else {
        "Unknown artist".into()
    };
    let mut parts = vec![artist, pluralize(a.album.track_count as u64, "track")];
    if a.source == TrackSource::Tidal {
        parts.push("TIDAL".into());
    }
    parts.join(" · ")
}

/// `artistSubtitle`.
fn artist_subtitle(a: &SearchArtist) -> String {
    let mut parts =
        vec![if a.source == TrackSource::Tidal { "TIDAL artist".to_string() } else { pluralize(a.artist.track_count as u64, "track") }];
    if a.artist.album_count > 0 {
        parts.push(pluralize(a.artist.album_count as u64, "album"));
    }
    parts.join(" · ")
}

pub fn pluralize(n: u64, singular: &str) -> String {
    format!("{n} {}", if n == 1 { singular.to_string() } else { format!("{singular}s") })
}

/// `searchEntityID`.
fn entity_id(id: &str, source: TrackSource, source_id: Option<&str>) -> String {
    if source == TrackSource::Tidal {
        source_id.filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| id.trim_start_matches("tidal:").to_string())
    } else {
        id.to_string()
    }
}

/// Every item in cmdk's tree order, grouped.
fn groups(app: &App) -> Vec<Group> {
    let s = &app.overlays.palette;
    let q = s.query.text.trim().to_string();
    let kind = s.search_type;
    let searching = searching(s);
    let mut out = Vec::new();

    if !s.albums.is_empty() {
        let items = s
            .albums
            .iter()
            .map(|a| {
                let tidal = a.source == TrackSource::Tidal;
                let id = entity_id(&a.album.id, a.source, a.source_id.as_deref());
                let art = media::album_art(&a.album.id, Some(a.album.has_cover), a.cover_url.as_deref(), Some(a.source), Some(64), None);
                Item {
                    value: format!("album {} {} {}", a.album.id, a.album.title, a.album.artist_name.as_deref().unwrap_or("")),
                    lead: Lead::Cover { url: art, label: a.album.title.clone(), round: false },
                    title: crate::format::display_text(Some(&a.album.title), ""),
                    sub: Some(album_subtitle(a)),
                    hint: Some("open".into()),
                    disabled: s.loading,
                    act: Act::Go(library_href(
                        &q,
                        kind,
                        &format!("&{}={}", if tidal { "tidalAlbum" } else { "album" }, urlencoding::encode(&id)),
                    )),
                }
            })
            .collect();
        out.push(Group { heading: Some("Albums"), items });
    }
    if !s.artists.is_empty() {
        let items = s
            .artists
            .iter()
            .map(|a| {
                let tidal = a.source == TrackSource::Tidal;
                let id = entity_id(&a.artist.id, a.source, a.source_id.as_deref());
                let art = a.cover_url.as_deref().filter(|u| !u.is_empty()).map(|u| media::resolve_cover(u, Some(64)));
                Item {
                    value: format!("artist {} {}", a.artist.id, a.artist.name),
                    lead: Lead::Cover { url: art, label: a.artist.name.clone(), round: true },
                    title: crate::format::display_text(Some(&a.artist.name), ""),
                    sub: Some(artist_subtitle(a)),
                    hint: Some("open".into()),
                    disabled: s.loading,
                    act: Act::Go(library_href(
                        &q,
                        kind,
                        &format!(
                            "&{}={}&artistName={}",
                            if tidal { "tidalArtist" } else { "artist" },
                            urlencoding::encode(&id),
                            urlencoding::encode(&a.artist.name)
                        ),
                    )),
                }
            })
            .collect();
        out.push(Group { heading: Some("Artists"), items });
    }
    if !s.tracks.is_empty() {
        let items = s
            .tracks
            .iter()
            .enumerate()
            .map(|(n, t)| {
                let mut sub = crate::format::display_text(t.artist.as_deref(), "Unknown artist");
                if let Some(al) = t.album_title.as_deref().filter(|a| !a.is_empty()) {
                    sub.push_str(&format!(" · {}", crate::format::display_text(Some(al), "")));
                }
                if t.source == Some(TrackSource::Tidal) {
                    sub.push_str(" · TIDAL");
                }
                let label = t.album_title.clone().filter(|a| !a.is_empty()).unwrap_or_else(|| t.title.clone());
                Item {
                    value: format!(
                        "track {} {} {} {}",
                        t.id,
                        t.title,
                        t.artist.as_deref().unwrap_or(""),
                        t.album_title.as_deref().unwrap_or("")
                    ),
                    lead: Lead::Cover {
                        url: Some(media::track_cover(&t.id, t.album_id.as_deref(), t.cover_url.as_deref(), Some(64))),
                        label,
                        round: false,
                    },
                    title: crate::format::display_text(Some(&t.title), ""),
                    sub: Some(sub),
                    hint: Some("play".into()),
                    disabled: s.loading,
                    act: Act::Play(n),
                }
            })
            .collect();
        out.push(Group { heading: Some("Tracks"), items });
    }
    if searching {
        out.push(Group {
            heading: None,
            items: vec![icon_item("show all search results".into(), &i::SEARCH, "View all results", None, Act::Go(library_href(&q, kind, "")))],
        });
    }
    if searching && kind != SearchType::All {
        return out;
    }

    let nav = |label: &str, glyph: &'static Icon, to: &str, hint: Option<String>| {
        icon_item(format!("navigate {label}"), glyph, label, hint.or_else(|| Some(to.to_string())), Act::Go(to.to_string()))
    };
    let mut navigate = vec![
        nav("Home", &i::HOUSE, "/", None),
        nav("Tracks", &i::MUSIC, "/library", None),
        nav("Albums", &i::DISC_3, "/library?view=albums", None),
        nav("Artists", &i::USER_ROUND, "/library?view=artists", None),
        nav("Favorites", &i::HEART, "/favorites", None),
        nav("Recent", &i::CLOCK, "/recent", None),
        nav("Playlists", &i::LIST_MUSIC, "/playlists", None),
    ];
    if app.pending_invites > 0 {
        navigate.push(nav("Pending invites", &i::MAIL, "/invites", Some(app.pending_invites.to_string())));
    }
    if app.me().is_some_and(|m| m.is_admin()) {
        navigate.push(nav("Admin", &i::SETTINGS, "/admin", None));
    }
    out.push(Group { heading: Some("Navigate"), items: navigate });

    if let Some(ps) = app.playlists.as_ref().filter(|p| !p.is_empty()) {
        let items = ps
            .iter()
            .map(|p| Item {
                value: format!("playlist {}", p.name),
                lead: Lead::Icon(&i::LIST_MUSIC),
                title: p.name.clone(),
                sub: Some(if p.visibility == crate::api::Visibility::Collaborative { "collaborative" } else { "private" }.into()),
                hint: None,
                disabled: false,
                act: Act::Go(format!("/playlists/{}", p.id)),
            })
            .collect();
        out.push(Group { heading: Some("Playlists"), items });
    }

    let playing = app.player.playing;
    let has_track = app.player.has_track();
    let pb = |label: &str, keywords: &str, glyph: &'static Icon, cmd: Command, disabled: bool| Item {
        value: format!("playback {label} {keywords}"),
        lead: Lead::Icon(glyph),
        title: label.into(),
        sub: None,
        hint: None,
        disabled,
        act: Act::Run(cmd),
    };
    out.push(Group {
        heading: Some("Playback"),
        items: vec![
            pb(if playing { "Pause" } else { "Play" }, "playback toggle", if playing { &i::PAUSE } else { &i::PLAY }, Command::PlayPause, !has_track),
            pb("Next track", "skip forward", &i::SKIP_FORWARD, Command::Next, !has_track),
            pb("Previous track", "back prev", &i::SKIP_BACK, Command::Prev, !has_track),
            pb("Toggle shuffle", "random", &i::SHUFFLE, Command::Shuffle, false),
            pb("Cycle repeat", "repeat loop", &i::REPEAT, Command::Repeat, false),
        ],
    });

    let dark = app.theme().dark();
    let action = |label: &str, keywords: &str, glyph: &'static Icon, act: Act| Item {
        value: format!("action {label} {keywords}"),
        lead: Lead::Icon(glyph),
        title: label.into(),
        sub: None,
        hint: None,
        disabled: false,
        act,
    };
    out.push(Group {
        heading: Some("Actions"),
        items: vec![
            action(
                if dark { "Switch to light mode" } else { "Switch to dark mode" },
                "appearance theme dark light mode",
                if dark { &i::SUN } else { &i::MOON },
                Act::Run(Command::Theme),
            ),
            action(
                "Open settings",
                "tweaks preferences radius density layout output last.fm updates server discord desktop",
                &i::SLIDERS_HORIZONTAL,
                Act::Run(Command::Settings),
            ),
            action("Customize Home", "rearrange reorder move swap hide panels board layout", &i::LAYOUT_DASHBOARD, Act::Go("/?customize".into())),
            action("Upload music", "add import ingest files", &i::UPLOAD, Act::Run(Command::Upload)),
            action("New playlist", "create playlist", &i::PLUS, Act::Go("/playlists/new".into())),
            action("Sign out", "logout sign out", &i::LOG_OUT, Act::Run(Command::SignOut)),
        ],
    });
    out
}

/// What shows: with a short query, cmdk's filter (score > 0) and ranking
/// (items by score, groups by their best item); otherwise everything.
fn visible(app: &App) -> Vec<Group> {
    let s = &app.overlays.palette;
    let mut all = groups(app);
    let search = s.query.text.as_str();
    if searching(s) || search.is_empty() {
        return all;
    }
    let mut ranked: Vec<(f64, Group)> = all
        .drain(..)
        .filter_map(|mut g| {
            let mut scored: Vec<(f64, Item)> =
                g.items.drain(..).map(|it| (score::command_score(&it.value, search), it)).filter(|(sc, _)| *sc > 0.0).collect();
            if scored.is_empty() {
                return None;
            }
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            let best = scored[0].0;
            g.items = scored.into_iter().map(|(_, it)| it).collect();
            Some((best, g))
        })
        .collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    ranked.into_iter().map(|(_, g)| g).collect()
}

/// The highlighted item's value: the chosen one while it shows and can be
/// picked, else the first that can.
fn current(s: &State, list: &[&Item]) -> Option<String> {
    if let Some(v) = &s.selected
        && list.iter().any(|it| &it.value == v && !it.disabled)
    {
        return Some(v.clone());
    }
    list.iter().find(|it| !it.disabled).map(|it| it.value.clone())
}

fn item_key(value: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in value.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("cmdk-item-{h:x}")
}

fn run(app: &mut App, act: Act) {
    let tracks = app.overlays.palette.tracks.clone();
    close(app);
    match act {
        Act::Go(href) => app.navigate_to(&href),
        Act::Play(n) => app.player.play_list(tracks, n),
        Act::Run(cmd) => match cmd {
            Command::PlayPause => app.player.toggle_play(),
            Command::Next => app.player.next(),
            Command::Prev => app.player.previous(),
            Command::Shuffle => app.player.toggle_shuffle(),
            Command::Repeat => app.player.cycle_repeat(),
            Command::Theme => app.toggle_theme(),
            Command::Settings => crate::overlays::settings::open(app),
            Command::Upload => crate::overlays::upload::open(app),
            Command::SignOut => app.sign_out(),
        },
    }
}

/// Arrows, Home/End, Ctrl+N/J/P and Enter, as cmdk's root handles them.
fn on_input_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    let groups = visible(app);
    let list: Vec<&Item> = groups.iter().flat_map(|g| g.items.iter()).collect();
    let s = &app.overlays.palette;
    let enabled: Vec<&Item> = list.iter().copied().filter(|it| !it.disabled).collect();
    let at = current(s, &list).and_then(|v| enabled.iter().position(|it| it.value == v));
    let step = |d: isize| -> Option<String> {
        if enabled.is_empty() {
            return None;
        }
        let n = enabled.len() as isize;
        let next = match at {
            Some(i) => (i as isize + d).rem_euclid(n),
            None => 0,
        };
        Some(enabled[next as usize].value.clone())
    };
    let target = match &ev.key {
        Key::Down => step(1),
        Key::Up => step(-1),
        Key::Command('n') | Key::Command('j') if !ev.mods.shift => step(1),
        Key::Command('p') if !ev.mods.shift => step(-1),
        Key::Home => enabled.first().map(|it| it.value.clone()),
        Key::End => enabled.last().map(|it| it.value.clone()),
        Key::Enter => {
            // Mid-search, Enter would run a stale highlight from the last query.
            if s.loading {
                return true;
            }
            let pick = current(s, &list).and_then(|v| list.iter().find(|it| it.value == v).map(|it| it.act.clone()));
            if let Some(act) = pick {
                run(app, act);
            }
            return true;
        }
        _ => return false,
    };
    if let Some(v) = target {
        tx.scroll_into_view(item_key(&v));
        app.overlays.palette.selected = Some(v);
    }
    true
}

fn item_view(app: &App, t: &Theme, it: &Item, selected: bool) -> El {
    let lead = match &it.lead {
        Lead::Icon(g) => ico(g, 16.0, t.c.muted_foreground),
        Lead::Cover { url, label, round } => {
            let r = if *round { 999.0 } else { t.radius_md() };
            cover_art(t, &app.images, url.as_deref(), label, 28.0, 28.0, r)
        }
    };
    let mut main = col().grow(1.0).min_w(0.0).gap(1.0).child(line(it.title.clone(), font(14.0, 500.0), t.c.foreground));
    if let Some(sub) = &it.sub {
        main = main.child(line(sub.clone(), font(12.0, 400.0), t.c.muted_foreground));
    }
    // CSS heights: 6 + 20.3 (+ 1 + 17.4) + 6; rune rounds text boxes up.
    let mut r = row()
        .key(item_key(&it.value))
        .w_full()
        .h(if it.sub.is_some() { 50.7 } else { 32.3 })
        .px(8.0)
        .py(6.0)
        .gap(8.0)
        .items_center()
        .radius(t.radius_lg())
        .role("option")
        .label(it.title.clone())
        .checked(selected)
        .child(lead)
        .child(main);
    if let Some(h) = &it.hint {
        r = r.child(text(h.clone()).font(font(12.0, 400.0).tracking(1.2)).color(t.c.muted_foreground));
    }
    if selected {
        r = r.fill(t.c.muted);
    }
    if it.disabled {
        return r.opacity(0.5).disabled(true);
    }
    let value = it.value.clone();
    let act = it.act.clone();
    r.cursor(Cursor::Default)
        .on_hover_change(move |app: &mut App, inside, _| {
            if inside && app.overlays.palette.selected.as_deref() != Some(&value) {
                app.overlays.palette.selected = Some(value.clone());
            }
        })
        .on_press(move |app: &mut App| run(app, act.clone()))
}

/// `.cmdk-kbd`.
fn cmdk_kbd(t: &Theme, k: &str) -> El {
    el().h(20.0)
        .min_w(20.0)
        .px(4.0)
        .radius(t.radius_sm())
        .fill(t.c.muted)
        .center()
        .child(text(k).font(tnum(font(12.0, 500.0))).color(t.c.muted_foreground))
}

/// The footer's height: its 20 px key caps set the line, 8 px around, a 1 px border.
const FOOTER_H: f32 = 37.0;

fn footer(t: &Theme) -> El {
    let hint = |keys: &[&str], what: &str| {
        let mut r = row().items_center();
        for k in keys {
            r = r.child(cmdk_kbd(t, k));
        }
        r.child(text(format!(" {what}")).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground))
    };
    let bar = row()
        .key("cmdk-footer")
        .w_full()
        .h(FOOTER_H)
        .px(12.0)
        .pt(1.0)
        .gap(12.0)
        .items_center()
        .child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(1.0).fill(t.c.border).inert())
        .child(hint(&["↵"], "to select"))
        .child(hint(&["↑", "↓"], "to navigate"))
        .child(hint(&["esc"], "to close"))
        .child(el().grow(1.0))
        .child(text("Lumen").font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground));
    bar
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    if !app.ui.palette_open {
        return None;
    }
    let s = &app.overlays.palette;
    let [_, wh] = super::window_size(cx);
    let groups = visible(app);
    let flat: Vec<&Item> = groups.iter().flat_map(|g| g.items.iter()).collect();
    let selected = current(s, &flat);

    let input = rune::text_input(&s.query, font(14.0, 400.0))
        .key("cmdk-input")
        .single_line()
        .placeholder(format!("Type a command or search {}…", s.search_type.noun()), t.c.muted_foreground)
        .label("Command palette")
        .color(t.c.foreground)
        .selection_color(t.c.selection)
        .grow(1.0)
        .min_w(0.0)
        .on_edit(|app: &mut App| &mut app.overlays.palette.query)
        .on_input_change(|app: &mut App, _| refresh(app))
        .on_input_key(on_input_key);
    let input_row = css_border_bottom(row(), 1.0, t.c.border)
        .key("cmdk-input-row")
        .h(44.0)
        .px(12.0)
        .pb(1.0)
        .gap(8.0)
        .items_center()
        .child(ico(&i::SEARCH, 16.0, t.c.muted_foreground))
        .child(input)
        .child(segmented_sized(t, "cmdk-type", SEARCH_TYPES, s.search_type, pick_type, SegSize::SMALL));

    let mut items = col().key("cmdk-items").w_full().padding(4.0);
    if s.loading {
        items = items.child(text("Searching…").font(font(14.0, 400.0)).color(t.c.popover_foreground));
    }
    let empty = |msg: &str, alert: bool| {
        let e = el().w_full().px(12.0).py(24.0).center().child(text(msg).font(font(14.0, 400.0)).color(t.c.muted_foreground).wrap());
        if alert { e.role("alert") } else { e }
    };
    if let Some(err) = &s.error {
        items = items.child(empty(err, true));
    } else if flat.is_empty() {
        items = items.child(empty("No results.", false));
    }
    for g in &groups {
        let mut group = col().w_full();
        if let Some(h) = g.heading {
            group = group.child(
                el().h(29.4).px(8.0).items_center().child(text(h).font(font(12.0, 500.0)).color(t.c.muted_foreground)),
            );
        }
        for it in &g.items {
            group = group.child(item_view(app, t, it, selected.as_deref() == Some(it.value.as_str())));
        }
        items = items.child(group);
    }

    // `max-height: 70vh` on the box, less the input row, footer and borders.
    let max_list = (wh * 0.7 - 2.0 - 44.0 - FOOTER_H).max(80.0);
    let content_h = cx.layout_size("cmdk-items").map(|s| s[1]);
    let overflows = content_h.is_none_or(|h| h > max_list + 0.5);
    let list = scroll_area_fit(t, "cmdk-list", items.role("listbox"), overflows, Some(max_list));

    let a = t.c.shadow_md_alpha;
    let r = t.radius_xl();
    let panel = css_border(col(), 1.0, t.c.border, r)
        .key("cmdk-root")
        .w_full()
        .max_w(640.0)
        .max_h(wh * 0.7)
        .padding(1.0)
        .radius(r)
        .fill(t.c.popover)
        .box_shadow(Shadow { x: 0.0, y: 4.0, blur: 6.0, spread: -1.0, color: Color::BLACK.alpha(a), inset: false })
        .box_shadow(Shadow { x: 0.0, y: 2.0, blur: 4.0, spread: -2.0, color: Color::BLACK.alpha(a), inset: false })
        .clip_rounded(r)
        .role("dialog")
        .label("Command palette")
        .child(input_row)
        .child(list)
        .child(footer(t));
    Some(
        col()
            .key("cmdk-layer")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .items_center()
            .px(16.0)
            .pt((wh * 0.12).floor())
            .modal(true, close)
            .child(
                el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .fill(t.c.scrim)
                    .backdrop_blur(4.0)
                    .on_press(close),
            )
            .child(panel),
    )
}
