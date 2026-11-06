//! Stand-ins for the shared components the Library pages use, which are
//! ported elsewhere: `TrackList` (with `TrackRowCells` and the
//! `TrackSelectionToolbar` portaled into a page's host), `Section`,
//! `ShelfScroller`, the track context menu and `EditAlbumDialog`.
//!
//! TODO(components-merge): rewrite each function here to call the real
//! component (`ui::track_list`, `overlays::track_menu::open`, …). The pages
//! only reach those components through this file.

use rune::{Color, Cursor, El, col, el, row, text};

use crate::api::{Album, TrackListItem, TrackSource};
use crate::app::App;
use crate::format::{display_text, fmt_duration_ms};
use crate::theme::Theme;
use crate::ui::{self, BtnState, font, ico, icons as i, iconbtn, line, tnum};

use super::logic;

/// Where a list's selection controls go (`selectionControlsHostId`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    /// The browse toolbar's group (`library-track-selection-controls`).
    LibraryToolbar,
    /// The album sleeve's tool row (`album-track-selection`).
    AlbumTools,
}

/// `TrackList`'s props the pages use.
#[derive(Clone)]
pub struct TableOptions {
    pub show_cover: bool,
    pub show_album: bool,
    pub show_header: bool,
    pub selectable: bool,
    pub show_source_badge: bool,
    /// The page's own artists: rows crediting only them leave out the artist line.
    pub omit_artists: Vec<String>,
    /// Where the selection toolbar portals to; inline above the table without one.
    pub host: Option<Host>,
    /// `.table-scroll .table { min-width: 720px }`: wider than its box, the
    /// table scrolls sideways (the album sleeve's list sets 0).
    pub min_width: f32,
}

impl Default for TableOptions {
    fn default() -> Self {
        TableOptions {
            show_cover: true,
            show_album: true,
            show_header: true,
            selectable: true,
            show_source_badge: true,
            omit_artists: Vec::new(),
            host: None,
            min_width: 720.0,
        }
    }
}

fn selecting(app: &App, host: Option<Host>) -> bool {
    host.is_some() && app.pages.library.selecting == host
}

/// `TrackList`: the track table. `rows` are shown, `queue` is what a row
/// plays through. `empty` shows when there are no rows.
// TODO(components-merge): `ui::track_list::view`.
pub fn track_table(
    app: &App,
    t: &Theme,
    key: &str,
    rows: &[TrackListItem],
    queue: &[TrackListItem],
    opts: &TableOptions,
    empty: Option<El>,
) -> El {
    let mut out = col().key(key).w_full().min_w(0.0);
    if opts.selectable && opts.host.is_none() {
        out = out.child(inline_selectbar(t, key, rows.len()));
    }
    if rows.is_empty()
        && let Some(e) = empty
    {
        return out.child(e);
    }
    let sel = opts.selectable && opts.host.is_some() && selecting(app, opts.host);
    let width = app.pages.library.table_widths.get(key).copied().unwrap_or(900.0).max(opts.min_width);
    let album_w = (width * 0.25).floor();
    // A headless table keeps a 16 px header row (its hidden select-all box).
    let header_h = if opts.show_header { 40.0 } else { 16.0 };
    let mut table = col().key(format!("{key}-table")).w(width);
    if !opts.show_header {
        table = table.child(el().h(header_h));
    }
    if opts.show_header {
        let h = |s: &str| text(s.to_string()).font(font(12.0, 500.0)).color(t.c.muted_foreground);
        let mut head = row().h(header_h).w_full().items_center();
        if sel {
            head = head.child(el().w(32.0).h_full().center().child(checkbox(t)));
        }
        head = head.child(el().w(40.0).px(8.0).justify_end().child(h("#")));
        if opts.show_cover {
            head = head.child(el().w(44.0));
        }
        head = head.child(el().grow(1.0).min_w(0.0).px(8.0).child(h("Title")));
        if opts.show_album {
            head = head.child(el().w(album_w).px(8.0).child(h("Album")));
        }
        head = head.child(el().w(64.0).px(8.0).justify_end().child(h("Time")));
        head = head.child(el().w(80.0));
        table = table.child(ui::css_border_bottom(head, 1.0, t.c.border));
    }
    let current = app.player.current().map(|c| c.id.clone());
    for (n, tr) in rows.iter().enumerate() {
        let now = current.as_deref() == Some(tr.id.as_str());
        let cell_ink = if now { t.c.foreground } else { t.c.muted_foreground };
        let mut r = row().key(format!("{key}-r{n}")).h(t.row_h()).w_full().items_center().cursor(Cursor::Pointer);
        if !opts.show_header {
            r = r.radius(t.radius_lg());
        }
        r = r.hover(t.c.ghost_hover);
        if tr.unavailable == Some(true) {
            r = r.opacity(0.45).help("No longer on TIDAL");
        }
        if sel {
            r = r.child(el().w(32.0).h_full().center().child(checkbox(t)));
        }
        r = r.child(
            el().w(40.0)
                .px(8.0)
                .justify_end()
                .child(text(format!("{:02}", n + 1)).font(tnum(font(12.0, 400.0))).color(cell_ink)),
        );
        if opts.show_cover {
            let (w, s) = if opts.show_header { (44.0, 32.0) } else { (56.0, 40.0) };
            let url = crate::api::media::track_cover(&tr.id, tr.album_id.as_deref(), tr.cover_url.as_deref(), Some(64));
            let label = tr.album_title.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| tr.title.clone());
            r = r.child(el().w(w).px(8.0).child(ui::cover_art(t, &app.images, Some(&url), &label, s, s, t.radius_md())));
        }
        let mut title_line = row().gap(0.0).items_center().min_w(0.0).child(line(
            display_text(Some(&tr.title), ""),
            font(14.0, 500.0),
            t.c.foreground,
        ));
        if opts.show_source_badge && tr.source == Some(TrackSource::Tidal) {
            let label = if tr.unavailable == Some(true) { "Removed from TIDAL" } else { "TIDAL" };
            title_line = title_line.child(badge(t, label).ml(8.0));
        }
        if let Some(aka) = tr.aka.as_deref().filter(|s| !s.is_empty()) {
            let count = aka.split(" • ").count();
            title_line = title_line
                .child(text(format!("(+{count})")).font(font(12.0, 400.0)).color(t.c.muted_foreground).ml(6.0));
        }
        let mut title_cell = col().grow(1.0).min_w(0.0).px(8.0).child(title_line);
        let show_artist = opts.omit_artists.is_empty() || !logic::credits_only(tr.artist.as_deref(), &opts.omit_artists);
        if show_artist {
            title_cell = title_cell.child(line(
                display_text(tr.artist.as_deref(), "Unknown artist"),
                font(12.0, 400.0),
                t.c.muted_foreground,
            ));
        }
        r = r.child(title_cell);
        if opts.show_album {
            let album = tr.album_title.as_deref().map(|a| display_text(Some(a), "")).unwrap_or_else(|| "—".into());
            r = r.child(el().w(album_w).px(8.0).min_w(0.0).child(line(album, tnum(font(12.0, 400.0)), t.c.muted_foreground)));
        }
        r = r.child(
            el().w(64.0)
                .px(8.0)
                .justify_end()
                .child(text(fmt_duration_ms(tr.duration_ms)).font(tnum(font(12.0, 400.0))).color(cell_ink)),
        );
        r = r.child(el().w(80.0));
        let id = tr.id.clone();
        let q: Vec<TrackListItem> = queue.to_vec();
        r = r.on_double_press(move |app: &mut App| logic::play_from_list(&mut app.player, &q, &id));
        if opts.show_header {
            r = ui::css_border_bottom(r, 1.0, t.c.border);
        }
        table = table.child(r);
    }
    let k = key.to_string();
    let scroller = el().key(format!("{key}-scroll")).w_full().min_w(0.0).scroll_x().child(table);
    out.child(scroller.on_layout(move |app: &mut App, rect: [f32; 4]| {
        let w = rect[2];
        let slot = app.pages.library.table_widths.entry(k.clone()).or_insert(0.0);
        if (*slot - w).abs() > 0.5 {
            *slot = w;
        }
    }))
}

fn checkbox(t: &Theme) -> El {
    ui::css_border(el(), 1.0, t.c.input, 4.0).size(16.0, 16.0).radius(4.0).fill(t.c.input_bg)
}

/// `.badge`.
pub fn badge(t: &Theme, label: &str) -> El {
    row()
        .h(20.0)
        .px(8.0)
        .items_center()
        .radius(999.0)
        .fill(t.c.secondary)
        .child(text(label.to_string()).font(font(12.0, 500.0)).color(t.c.secondary_foreground))
}

/// The selection toolbar a list shows above itself without a host.
fn inline_selectbar(t: &Theme, key: &str, total: usize) -> El {
    let status = if total == 1 { "1 track".to_string() } else { format!("{total} tracks") };
    row()
        .key(format!("{key}-selectbar"))
        .min_h(38.0)
        .pb(8.0)
        .gap(8.0)
        .items_center()
        .child(text(status).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground).grow(1.0))
        .child(ui::Btn::new(format!("{key}-select"), "Select").icon(&i::CHECK).build(t).h(30.0))
}

/// The selection controls a page's host shows: "Select", or while
/// selecting the count, Select all, Export files and clear. Returns the
/// controls and whether the list is selecting (the browse toolbar hides its
/// sort and view controls meanwhile). `ready` is false while the list loads
/// (a disabled Select holds the place).
// TODO(components-merge): the controls `ui::track_list` portals into `host`.
pub fn selection_controls(app: &App, t: &Theme, host: Host, ready: bool) -> (Vec<El>, bool) {
    let on = ready && app.pages.library.selecting == Some(host);
    let in_group = host == Host::LibraryToolbar;
    let btn = |key: &str, label: &str, glyph: Option<&'static rune::Icon>, disabled: bool| -> El {
        if in_group {
            let ink = t.c.muted_foreground;
            let hot = crate::theme::color_mix(t.c.foreground, 0.07, Color::TRANSPARENT);
            let mut b = row().key(key.to_string()).h(26.0).px(9.0).gap(6.0).items_center().radius(t.radius_md()).role("button");
            if let Some(g) = glyph {
                b = b.child(ico(g, 14.0, ink).group_color(t.c.foreground));
            }
            b = b.child(text(label.to_string()).font(font(14.0, 500.0)).color(ink).group_color(t.c.foreground));
            if disabled { b.opacity(0.5).disabled(true) } else { b.hover(hot).cursor(Cursor::Pointer).press_scale(0.97) }
        } else {
            let mut b = ui::Btn::new(key, label);
            if let Some(g) = glyph {
                b = b.icon(g);
            }
            b.disabled(disabled).build(t).h(30.0)
        }
    };
    if !on {
        let b = btn(&format!("{host:?}-select"), "Select", Some(&i::CHECK), !ready);
        let b = if ready { b.on_press(move |app: &mut App| app.pages.library.selecting = Some(host)) } else { b };
        return (vec![b], false);
    }
    let status = text("0 selected").font(tnum(font(14.0, 500.0))).color(t.c.foreground).px(6.0);
    let all = btn(&format!("{host:?}-all"), "Select all", None, false);
    let export = btn(&format!("{host:?}-export"), "Export files", Some(&i::DOWNLOAD), true).ml(6.0);
    let close = iconbtn(t, &format!("{host:?}-clear"), &i::X, 16.0, BtnState::default())
        .size(if in_group { 26.0 } else { 30.0 }, if in_group { 26.0 } else { 30.0 })
        .label("Clear selection")
        .ml(6.0)
        .on_press(|app: &mut App| app.pages.library.selecting = None);
    (vec![status, all, export, close], true)
}

/// `Section` (`.section-head` with the artist page's 18 px title).
// TODO(components-merge): the shared `Section`.
pub fn section(t: &Theme, key: &str, title: &str, action: Option<El>, body: Vec<El>) -> El {
    let style = font(18.0, 600.0).tracking(-0.27);
    let mut head = row().mb(10.0).gap(16.0).items_center().justify_between().child(super::exact(
        text(title.to_string()).font(style).color(t.c.foreground),
        style,
        1,
    ));
    if let Some(a) = action {
        head = head.child(a);
    }
    let mut s = col().key(key).w_full().child(head);
    for b in body {
        s = s.child(b);
    }
    s
}

/// `ShelfScroller`: a row of 168 px cards that scrolls sideways.
// TODO(components-merge): the shared `ShelfScroller` (edge fades, paging arrows).
pub fn shelf(t: &Theme, key: &str, label: &str, cards: Vec<El>) -> El {
    let mut r = row().gap(t.gap()).items_start();
    for c in cards {
        r = r.child(c.w(168.0));
    }
    el().key(key).w_full().label(label.to_string()).scroll_x().child(r)
}

/// Opens the track context menu (`useTrackContextMenu().bind`).
// TODO(components-merge): `overlays::track_menu::open`.
pub fn open_track_menu(app: &mut App, track: &TrackListItem, queue: &[TrackListItem], at: [f32; 2]) {
    let _ = (app, track, queue, at);
}

/// Opens `EditAlbumDialog` for `album`.
// TODO(components-merge): `overlays::edit::open_album`.
pub fn edit_album(app: &mut App, album: &Album) {
    let _ = (app, album);
}
