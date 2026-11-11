//! `Board.tsx` (`board.css`): the pieces of Home's board. A panel (eyebrow,
//! title, "view all", its own loading and error state) and the compact rows
//! and tiles panels list. Every row is one click from playing or opening.

use std::rc::Rc;

use rune::{Cursor, El, TextStyle, col, el, row, text};

use crate::api::{Playlist, TrackListItem};
use crate::app::App;
use crate::theme::{Density, Theme};
use crate::ui::blocks::SectionLook;
use crate::ui::{Btn, cover_art, css_baseline, font, ico, icons as i, line, skeleton_line, tnum, track_row as rows, with_lh};

use crate::ui::cards::{Action, disc, playlist_subtitle, top_artist_glyph, top_artist_press};
use crate::ui::tooltip::TipExt;
use super::logic::TopArtistAction;
use crate::ui::ShadowMd;
use crate::format::clean_text;

/// Row art is 40-48px; the server's next size up covers a 2x screen.
pub const ROW_ART_SIZE: u32 = 128;
/// `.board-row`'s height.
pub const ROW_H: f32 = 52.0;
/// `.board-artist`: 48 px avatar in 8 px padding.
pub const ARTIST_H: f32 = 64.0;

/// Text held in a box `h` tall: Chromium stacks fractional line boxes (a
/// 12 px line is 17.4 px), where Rune rounds each text's box up to a whole
/// pixel, so stacked lines would drift a pixel or two.
pub fn lh(e: El, h: f32) -> El {
    col().h(h).min_w(0.0).child(e)
}

/// `.card-title`'s size (12 px on dense boards).
pub fn title_size(t: &Theme) -> f32 {
    if t.density == Density::Dense { 12.0 } else { 14.0 }
}

// ── The panel ───────────────────────────────────────────────────────────────

/// `.section-sub`.
fn sub_style() -> TextStyle {
    font(12.0, 400.0)
}
/// `.section-title`: 16 px semibold, -0.01em.
fn title_style() -> TextStyle {
    SectionLook::default().title
}
const LINK: &str = "view all →";

/// The head's text column sits lower than the "view all" link by the
/// difference of their baselines (`.section-head`'s `align-items: baseline`).
fn head_shift() -> f32 {
    css_baseline(14.0, 20.3) - css_baseline(12.0, 17.4)
}

/// How wide the title may be in a panel `content` wide.
fn title_room(content: f32) -> f32 {
    let link = rune::text::measure(LINK, &[], font(14.0, 400.0), None).0;
    (content - 16.0 - link).max(0.0)
}

/// The title's height: 23.2 px a line, wrapping when long.
fn title_height(title: &str, content: f32) -> f32 {
    crate::ui::css_text_h_with(title, title_style(), Some(title_room(content)), rune::text::RichLayoutOptions::new().wrap_anywhere())
}

/// The panel head's height (eyebrow and title).
pub fn head_height(title: &str, content: f32) -> f32 {
    head_shift() + 17.4 + title_height(title, content)
}

/// The space a panel's frame takes beyond its body: border, padding, the
/// head and its 4 px margin.
pub fn frame_height(title: &str, content: f32) -> f32 {
    2.0 + 32.0 + head_height(title, content) + 4.0
}

/// A panel's content width at a slot `w` wide.
pub fn content_width(w: f32) -> f32 {
    w - 34.0
}

/// `BoardPanel`'s head: eyebrow over title, "view all →" at the right.
fn head(t: &Theme, key: &str, sub: &str, title: &str, to: &str, content: f32) -> El {
    let to = to.to_string();
    let link = el()
        .key(format!("{key}-viewall"))
        .role("link")
        .label(LINK)
        .cursor(Cursor::Pointer)
        .hover_group()
        .child(text(LINK).font(font(14.0, 400.0)).color(t.c.muted_foreground).group_color(t.c.foreground))
        .on_press(move |app: &mut App| app.navigate_to(&to));
    row()
        .w_full()
        .gap(16.0)
        .items_start()
        .justify_between()
        .mb(4.0)
        .child(
            col()
                .mt(head_shift())
                .min_w(0.0)
                .shrink()
                .child(lh(text(sub.to_string()).font(sub_style()).color(t.c.muted_foreground), 17.4))
                .child(lh(
                    text(title.to_string()).font(title_style()).color(t.c.card_foreground).wrap_anywhere().max_w(title_room(content)),
                    title_height(title, content),
                )),
        )
        .child(link)
}

/// `.board-panel`: the card holding a panel, `w`×`h` in its slot.
pub struct Frame {
    pub key: String,
    pub sub: String,
    pub title: String,
    pub to: String,
    /// Why a Play from this panel failed (`.board-alert`).
    pub alert: Option<String>,
    /// `PanelStatus` (an error and Retry), when it shows.
    pub status: Option<El>,
    pub footer: Option<El>,
}

impl Frame {
    pub fn new(key: impl Into<String>, sub: impl Into<String>, title: impl Into<String>, to: impl Into<String>) -> Frame {
        Frame { key: key.into(), sub: sub.into(), title: title.into(), to: to.into(), alert: None, status: None, footer: None }
    }

    /// The panel around `body`, which takes the room left (the fill area).
    pub fn build(self, t: &Theme, w: f32, h: f32, body: El) -> El {
        let content = content_width(w);
        let r = t.radius_xl();
        let mut p = crate::ui::css_border(col(), 1.0, t.c.border, r)
            .key(self.key.clone())
            .w(w)
            .h(h)
            .padding(17.0)
            .radius(r)
            .fill(t.c.card)
            .child(head(t, &self.key, &self.sub, &self.title, &self.to, content));
        if let Some(a) = &self.alert {
            p = p.child(crate::ui::kit::error_banner(t, a).mb(8.0).role("alert"));
        }
        if let Some(s) = self.status {
            p = p.child(s);
        }
        p = p.child(body.grow(1.0).min_h(0.0));
        if let Some(f) = self.footer {
            p = p.child(el().w_full().pt(12.0).child(f));
        }
        p
    }
}

/// `.board-alert`'s height (the error banner and its 8 px margin).
pub fn alert_height(message: &str, content: f32) -> f32 {
    let (_, h) = rune::text::measure(message, &[], font(14.0, 400.0), Some(content - 28.0));
    2.0 + 18.0 + h.max(20.3) + 8.0
}

/// A panel's footer height (`.board-panel-foot`: 12 px over a 32 px button).
pub const FOOTER_H: f32 = 44.0;

/// `PanelStatus` with an error: the message and Retry (`.board-status`).
/// While loading it's for screen readers only, so it takes no room.
pub fn status(t: &Theme, key: &str, title: &str, error: &str, retry: Action) -> El {
    col()
        .key(format!("{key}-status"))
        .w_full()
        .py(8.0)
        .gap(8.0)
        .items_start()
        .role("status")
        .child(text(error.to_string()).font(font(14.0, 400.0)).color(t.c.muted_foreground).wrap())
        .child(
            Btn::new(format!("{key}-retry"), format!("Retry {}", title.to_lowercase()))
                .small()
                .build(t)
                .on_press(move |app: &mut App| retry(app)),
        )
}

pub fn status_height(error: &str, content: f32) -> f32 {
    let (_, h) = rune::text::measure(error, &[], font(14.0, 400.0), Some(content));
    16.0 + h.max(20.3) + 8.0 + 28.0
}

// ── Rows ────────────────────────────────────────────────────────────────────

/// The list a row plays through and its menu queues, read when it's used
/// (`usePlayFromList`'s ref), so a panel holds no copy of a list the state
/// already has.
#[derive(Clone)]
pub enum Queue {
    /// One of Home's lists, found again in the state.
    Of(Rc<dyn Fn(&App) -> &[TrackListItem]>),
    /// Rows a panel worked out (On repeat's).
    Rows(Rc<Vec<TrackListItem>>),
}

impl Queue {
    pub fn of(f: impl Fn(&App) -> &[TrackListItem] + 'static) -> Queue {
        Queue::Of(Rc::new(f))
    }

    pub fn read<'a>(&'a self, app: &'a App) -> &'a [TrackListItem] {
        match self {
            Queue::Of(f) => f(app),
            Queue::Rows(rows) => rows,
        }
    }
}

/// A track row's options (`BoardTrackList`'s props).
pub struct TrackRow {
    pub ranked: bool,
    /// A ranked row's number.
    pub rank: usize,
    /// Without covers (an album's tracks, under its cover).
    pub bare: bool,
    /// The track you were on.
    pub current: bool,
    /// The end column (a duration, a play count).
    pub meta: String,
    /// What a press plays from (its playable rows, `play(track, queue)`)
    /// and the menu queues.
    pub queue: Queue,
}

fn row_box(t: &Theme, key: String) -> El {
    row()
        .key(key)
        .w_full()
        .h(ROW_H)
        .px(8.0)
        .gap(12.0)
        .items_center()
        .radius(t.radius_lg())
}

/// The round play button (`.board-play`), 28 px, shown on hover.
fn play_disc(t: &Theme) -> El {
    disc(t, &i::PLAY_FILLED, 28.0, 14.0).shadow_md(t)
}

fn row_text(t: &Theme, title: El, sub: &str) -> El {
    let fs = title_size(t);
    col()
        .grow(1.0)
        .min_w(0.0)
        .gap(1.0)
        .child(lh(title, fs * 1.45))
        .child(lh(line(sub.to_string(), font(12.0, 400.0), t.c.muted_foreground), 17.4))
}

/// One row of `BoardTrackList`.
pub fn track_row(app: &App, t: &Theme, key: String, track: &TrackListItem, o: TrackRow) -> El {
    let unavailable = track.unavailable == Some(true);
    let mut r = row_box(t, key.clone());
    if o.ranked {
        let ink = if o.current { t.c.foreground } else { t.c.muted_foreground };
        let mut num = text(o.rank.to_string()).font(tnum(font(14.0, 500.0))).color(ink);
        let mut cell = el().w(20.0).h_full().center();
        if !unavailable {
            num = num.group_opacity(1.0, 0.0);
            cell = cell.child(el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).center().child(
                ico(&i::PLAY_FILLED, 14.0, t.c.foreground).group_opacity(0.0, 1.0),
            ));
        }
        r = r.child(cell.child(num));
    }
    if !o.bare {
        let label = track.album_title.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| track.title.clone());
        r = r.child(cover_art(t, &app.images, Some(&track.cover_at(Some(ROW_ART_SIZE))), &label, 40.0, 40.0, t.radius_md()));
    }
    let title = line(clean_text(Some(&track.title)), font(title_size(t), 500.0), t.c.foreground);
    r = r.child(col().grow(1.0).min_w(0.0).gap(1.0)
        .child(lh(title, title_size(t) * 1.45))
        .child(lh(crate::ui::entity_links::artists(track, font(12.0, 400.0), t.c.muted_foreground), 17.4)));
    let meta = text(o.meta.clone()).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground);
    let mut end = el().h_full().items_center().justify_end();
    if o.ranked || unavailable {
        end = end.child(meta);
    } else {
        end = end
            .min_w(28.0)
            .child(meta.group_opacity(1.0, 0.0))
            .child(el().pin(None, Some(12.0), Some(0.0), None).child(play_disc(t).group_opacity(0.0, 1.0)));
    }
    r = r.child(end);
    let queue = o.queue.clone();
    let menu_track = track.clone();
    r = r.on_secondary_press(move |app: &mut App, at, _| {
        let ctx = crate::overlays::track_menu::MenuContext::bind(&menu_track, queue.read(app).to_vec());
        crate::overlays::track_menu::open(app, menu_track.clone(), [at.x, at.y], ctx)
    });
    if unavailable {
        return r.opacity(0.45).label(track.title.clone()).tip(&key, "No longer on TIDAL");
    }
    let (queue, tr) = (o.queue, track.clone());
    r.hover(t.c.accent)
        .hover_motion(crate::ui::motion::ease(100.0), crate::ui::motion::ease(100.0))
        .role("button")
        .label(format!("Play {}", track.title))
        .cursor(Cursor::Pointer)
        .focusable(true)
        .on_press(move |app: &mut App| {
            let list = queue.read(app).to_vec();
            rows::play_from(app, &tr, &list);
        })
}

/// `.board-list`: rows in one column, or two (top to bottom, then the next
/// column) once the panel's content is 600 px wide. `width` is the list's
/// own width (the content and its -8 px margins).
pub fn board_list(key: &str, rows: Vec<El>, content: f32) -> El {
    let width = content + 16.0;
    if list_columns(content) == 1 || rows.len() <= 1 {
        let mut c = col().key(key.to_string()).w(width).ml(-8.0);
        for r in rows {
            c = c.child(r);
        }
        return c;
    }
    let per = rows.len().div_ceil(2);
    let col_w = (width - 16.0) / 2.0;
    let mut left = col().w(col_w);
    let mut right = col().w(col_w);
    for (n, r) in rows.into_iter().enumerate() {
        if n < per {
            left = left.child(r);
        } else {
            right = right.child(r);
        }
    }
    row().key(key.to_string()).w(width).ml(-8.0).gap(16.0).items_start().child(left).child(right)
}

/// A panel's list columns: two at 600 px of content.
pub fn list_columns(content: f32) -> usize {
    if content >= 600.0 { 2 } else { 1 }
}

/// `BoardPlaylistList`'s row: the row opens the playlist, its button plays it.
pub fn playlist_row(app: &App, t: &Theme, key: String, p: &Playlist, on_play: Action) -> El {
    let art = match crate::api::media::playlist_art(p, Some(ROW_ART_SIZE)) {
        Some(url) => cover_art(t, &app.images, Some(&url), &p.name, 40.0, 40.0, t.radius_md()),
        None => el().size(40.0, 40.0).radius(t.radius_md()).fill(t.c.muted).center().child(ico(&i::LIST_MUSIC, 16.0, t.c.muted_foreground)),
    };
    let title = line(p.name.clone(), font(title_size(t), 500.0), t.c.foreground);
    let play_label = format!("Play {}", p.name);
    let play = el()
        .key(format!("{key}-play"))
        .role("button")
        .label(play_label)
        .hover(t.c.background.alpha(0.2))
        .focusable(true)
        .cursor(Cursor::Pointer)
        .press_scale(0.95)
        .group_opacity(0.0, 1.0)
        .child(play_disc(t))
        .on_press(move |app: &mut App| on_play(app));
    let href = format!("/playlists/{}", p.id);
    row_box(t, key)
        .child(art)
        .child(row_text(t, title, &playlist_subtitle(p)))
        .child(play)
        .hover(t.c.accent)
        .hover_motion(crate::ui::motion::ease(100.0), crate::ui::motion::ease(100.0))
        .role("link")
        .label(p.name.clone())
        .cursor(Cursor::Pointer)
        .focusable(true)
        .on_press(move |app: &mut App| app.navigate_to(&href))
}

/// An artist tile's item (`BoardArtistItem`).
pub struct ArtistItem {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub image: Option<String>,
    pub action: Option<TopArtistAction>,
    pub on_play: Action,
}

/// `.board-artists`' columns at a panel's content width.
pub fn artist_columns(content: f32) -> usize {
    if content < 480.0 {
        1
    } else if content < 700.0 {
        2
    } else if content >= 1300.0 {
        6
    } else if content >= 1040.0 {
        5
    } else {
        4
    }
}

/// `.board-covers`' columns at a panel's content width.
pub fn cover_columns(content: f32) -> usize {
    if content < 420.0 {
        2
    } else if content >= 920.0 {
        6
    } else if content >= 760.0 {
        5
    } else {
        4
    }
}

/// A 4 px-gapped grid of `columns` over the content and its -8 px margins,
/// 4 px below the head (`.board-covers`, `.board-artists`).
pub fn tile_grid(key: &str, tiles: Vec<El>, content: f32, columns: usize) -> El {
    let width = content + 16.0;
    let mut grid = col().key(key.to_string()).w(width).ml(-8.0).mt(4.0).gap(4.0);
    let mut it = tiles.into_iter().peekable();
    while it.peek().is_some() {
        let mut r = row().w_full().gap(4.0).items_start();
        for _ in 0..columns {
            match it.next() {
                Some(tile) => r = r.child(tile),
                None => break,
            }
        }
        grid = grid.child(r);
    }
    grid
}

/// The width of one tile in a [`tile_grid`].
pub fn tile_width(content: f32, columns: usize) -> f32 {
    (content + 16.0 - 4.0 * (columns as f32 - 1.0)) / columns as f32
}

/// `BoardArtistList`'s tile: opens the artist's page, or plays them when
/// they have none.
pub fn artist_tile(app: &App, t: &Theme, key: String, a: ArtistItem, width: f32) -> El {
    let mut avatar = el().size(48.0, 48.0).child(cover_art(t, &app.images, a.image.as_deref(), &a.name, 48.0, 48.0, 999.0));
    if let Some(glyph) = top_artist_glyph(t, a.action, 28.0, 14.0) {
        avatar = avatar.child(glyph.absolute(10.0, 10.0));
    }
    let name = line(clean_text(Some(&a.name)), font(title_size(t), 500.0), t.c.foreground);
    let mut tile = row()
        .key(key)
        .w(width)
        .padding(8.0)
        .gap(12.0)
        .items_center()
        .radius(t.radius_lg())
        .child(avatar)
        .child(row_text(t, name, &a.detail));
    if a.action.is_some() {
        tile = tile.hover(t.c.accent).hover_motion(crate::ui::motion::ease(100.0), crate::ui::motion::ease(100.0)).focusable(true);
    }
    top_artist_press(tile, a.action, &a.id, &a.name, a.on_play)
}

/// `BoardRowPlaceholders`: the same 52 px rows, so the panel keeps its height
/// when they arrive.
pub fn row_placeholders(t: &Theme, key: &str, count: usize, ranked: bool, bare: bool) -> Vec<El> {
    (0..count)
        .map(|n| {
            let mut r = row_box(t, format!("{key}-{n}")).a11y_hidden();
            if ranked {
                r = r.child(el().w(20.0));
            }
            if !bare {
                r = r.child(el().size(40.0, 40.0).radius(t.radius_md()).fill(t.c.muted));
            }
            r.child(skeleton_lines(t))
        })
        .collect()
}

fn skeleton_lines(t: &Theme) -> El {
    let fs = title_size(t);
    col().grow(1.0).min_w(0.0).gap(1.0).child(skeleton_line(t, fs, fs * 1.45, 0.7)).child(skeleton_line(t, 12.0, 17.4, 0.45))
}

/// `BoardArtistPlaceholders`.
pub fn artist_placeholders(t: &Theme, key: &str, count: usize, width: f32) -> Vec<El> {
    (0..count)
        .map(|n| {
            row()
                .key(format!("{key}-{n}"))
                .w(width)
                .padding(8.0)
                .gap(12.0)
                .items_center()
                .a11y_hidden()
                .child(el().size(48.0, 48.0).radius(999.0).fill(t.c.muted))
                .child(skeleton_lines(t))
        })
        .collect()
}

/// A line of text with the `.board-stat dd` style (24 px semibold, tabular).
pub fn stat_value_style() -> TextStyle {
    tnum(with_lh(font(24.0, 600.0), 34.8))
}
