//! Stand-ins for the shared components another agent is building:
//! `PlaylistCard`, `PlayListButton`, `Section`, `ListPageHeader`, the track
//! row cells (`TrackIndexCell`, `FavoriteButton`, `TrackSelectCell`,
//! `SelectAllHeaderCell`), `TrackSelectionToolbar` and the track context
//! menu. Each draws what its web component draws, closely enough to diff
//! against, and each is marked for the merge.
//
// TODO(components-merge): every function here becomes a call into
// `ui::track_list` / `ui::track_row` / `ui::track_select`, the shared cards,
// `Section`, `ListPageHeader` and `overlays::track_menu::open`.

use rune::{Color, Cursor, El, col, el, row, text};

use crate::api::{Playlist, TrackListItem, media};
use crate::app::App;
use crate::theme::{Theme, color_mix};
use crate::ui::{Btn, css_border, font, ico, icons as i, line, tnum, with_lh};

/// `PlaylistCard` (`cards.css` `.card`): the cover (or the list icon), the
/// name with a lock or people icon, and the subtitle. Opens the playlist.
// TODO(components-merge): the shared PlaylistCard.
pub fn playlist_card(app: &App, t: &Theme, p: &Playlist, width: f32) -> El {
    let art_w = (width - 16.0).max(0.0);
    let r = t.radius_lg();
    let art = match media::playlist_art(p, Some(384)) {
        Some(url) => crate::ui::cover_art(t, &app.images, Some(&url), &p.name, art_w, art_w, r),
        None => el().size(art_w, art_w).radius(r).fill(t.c.muted).center().child(ico(&i::LIST_MUSIC, 32.0, t.c.muted_foreground)),
    };
    let collab = p.visibility == crate::api::Visibility::Collaborative;
    let title = row()
        .gap(6.0)
        .items_center()
        .child(line(p.name.clone(), font(14.0, 500.0), t.c.foreground).grow(1.0).min_w(0.0))
        .child(ico(if collab { &i::USERS } else { &i::LOCK }, 12.0, t.c.muted_foreground));
    let to = format!("/playlists/{}", p.id);
    col()
        .key(format!("playlist-card-{}", p.id))
        .w(width)
        .padding(8.0)
        .gap(10.0)
        .radius(t.radius_xl())
        .cursor(Cursor::Pointer)
        .role("link")
        .label(p.name.clone())
        .focusable(true)
        .hover(t.c.ghost_hover)
        .on_press(move |app: &mut App| app.navigate_to(&to))
        .child(art)
        .child(col().child(title).child(line(super::logic::subtitle(p), font(12.0, 400.0), t.c.muted_foreground)))
}

/// `PlayListButton`: Play all, from the top (or a random track with shuffle
/// on).
// TODO(components-merge): the shared PlayListButton (startListPlayback).
pub fn play_list_button(t: &Theme, key: &str, tracks: Vec<TrackListItem>, disabled: bool, label: &str) -> El {
    let b = Btn::new(key, label).primary().icon(&i::PLAY_FILLED).icon_size(16.0).disabled(disabled).build(t);
    if disabled {
        return b;
    }
    b.on_press(move |app: &mut App| {
        let queue: Vec<TrackListItem> = tracks.iter().filter(|t| t.unavailable != Some(true)).cloned().collect();
        if queue.is_empty() {
            return;
        }
        let start = if app.player.shuffle { (super::logic::now_ms() as usize) % queue.len() } else { 0 };
        app.player.play_list(queue, start);
    })
}

/// `Section`: the 16 px title over its content (`home.css` `.section`).
// TODO(components-merge): the shared Section.
pub fn section(t: &Theme, title: &str, body: El) -> El {
    col()
        .child(
            el().mb(12.0)
                .child(text(title).font(with_lh(font(16.0, 600.0), 23.2).tracking(-0.16)).color(t.c.foreground).h(23.2)),
        )
        .child(body)
}

/// What `ListPageHeader` lays out (`detail.css` `.detail-header`).
pub struct Header {
    pub kind: El,
    pub title: El,
    pub description: Option<String>,
    pub art: El,
    pub meta: Option<El>,
    pub actions: Option<El>,
}

/// `ListPageHeader`: the card with the 200 px art and the title block
/// sitting on its bottom edge.
// TODO(components-merge): the shared ListPageHeader.
pub fn list_page_header(t: &Theme, h: Header) -> El {
    let mut body = col().grow(1.0).min_w(0.0).justify_end().child(h.kind).child(h.title);
    if let Some(d) = h.description {
        body = body.child(
            el().w_full().max_w(super::logic::ch60(14.0)).mb(10.0).child(text(d).font(font(14.0, 400.0)).color(t.c.muted_foreground).wrap().w_full()),
        );
    }
    if let Some(m) = h.meta {
        body = body.child(m);
    }
    if let Some(a) = h.actions {
        body = body.child(a.mt(16.0));
    }
    css_border(row(), 1.0, t.c.border, t.radius_xl())
        .w_full()
        .min_h(200.0)
        .padding(25.0)
        .gap(24.0)
        .items_end()
        .radius(t.radius_xl())
        .fill(t.c.card)
        .clip_rounded(t.radius_xl())
        .child(h.art)
        .child(body)
}

/// `PlayingBars`: three bars, drawn still.
// TODO(components-merge): ui::track_row::playing_bars (animated).
fn playing_bars(t: &Theme) -> El {
    let bar = |h: f32| el().w(2.0).h(14.0 * h).radius(1.0).fill(t.c.foreground);
    row().size(14.0, 14.0).gap(2.0).items_end().child(bar(0.4)).child(bar(0.8)).child(bar(0.6))
}

/// `TrackIndexCell`'s content: the zero-padded number (or the bars while
/// playing), with the play button over it on hover.
// TODO(components-merge): ui::track_row::index_cell + idx_play.
pub fn index_cell(t: &Theme, key: &str, index: usize, playing: bool, ink: Color, label: &str, on_play: impl Fn(&mut App) + 'static) -> El {
    let shown = if playing {
        playing_bars(t)
    } else {
        text(format!("{:02}", index + 1)).font(tnum(font(12.0, 400.0))).color(ink)
    };
    let play = el()
        .key(format!("{key}-play"))
        .size(24.0, 24.0)
        .center()
        .radius(t.radius_sm())
        .role("button")
        .label(label.to_string())
        .cursor(Cursor::Pointer)
        .child(ico(&i::PLAY_FILLED, 14.0, t.c.foreground))
        .on_press(on_play);
    el().size(24.0, 24.0)
        .child(el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).center().child(shown).group_opacity(1.0, 0.0))
        .child(play.group_opacity(0.0, 1.0).pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)))
}

/// `FavoriteButton` in `.row-actions`.
// TODO(components-merge): ui::track_row::favorite_button (pop animation, the favourites state).
pub fn favorite_button(t: &Theme, key: &str, id: &str, fav: bool) -> El {
    let id = id.to_string();
    row_action(t, key, if fav { &i::HEART_FILLED } else { &i::HEART }, if fav { t.c.foreground } else { t.c.muted_foreground })
        .label(if fav { "Remove from favorites" } else { "Add to favorites" })
        .checked(fav)
        .on_press(move |app: &mut App| {
            let pages = &mut app.pages;
            if !pages.favorite_ids.remove(&id) {
                pages.favorite_ids.insert(id.clone());
            }
        })
}

/// A `.row-actions button`: 28 px, muted, lit on hover.
pub fn row_action(t: &Theme, key: &str, glyph: &'static rune::Icon, ink: Color) -> El {
    el().key(key)
        .size(28.0, 28.0)
        .radius(t.radius_md())
        .center()
        .role("button")
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(t.c.accent)
        .child(ico(glyph, 14.0, ink).group_color(t.c.accent_foreground))
}

/// `TrackCheckbox` in the select column.
// TODO(components-merge): ui::track_select::checkbox.
pub fn checkbox(t: &Theme, key: &str, checked: bool, indeterminate: bool, label: &str) -> El {
    let mut b = el().key(key).size(16.0, 16.0).radius(3.0).center().role("checkbox").checked(checked).label(label.to_string());
    if checked || indeterminate {
        b = b.fill(t.c.primary).child(ico(if checked { &i::CHECK } else { &i::MINUS }, 12.0, t.c.primary_foreground));
    } else {
        b = css_border(b, 1.0, t.c.input, 3.0).fill(t.c.input_bg);
    }
    b.cursor(Cursor::Pointer).focusable(true)
}

/// What `TrackSelectionToolbar` needs to draw.
pub struct SelectionBar {
    pub selecting: bool,
    pub selected: usize,
    pub all_selected: bool,
    pub some_selected: bool,
}

/// `TrackSelectionToolbar` attached in its toolbar host: "Select", or the
/// count with Select all, Export files and the close button.
// TODO(components-merge): ui::track_select::selection_bar (export, notices).
pub fn selection_toolbar(t: &Theme, key: &str, s: SelectionBar, on_toggle: fn(&mut App), on_select_all: fn(&mut App), on_clear: fn(&mut App)) -> El {
    let hot = color_mix(t.c.foreground, 0.07, Color::TRANSPARENT);
    let seg = |k: String, glyph: Option<&'static rune::Icon>, label: &str| {
        let mut b = row()
            .key(k)
            .h(26.0)
            .px(9.0)
            .gap(6.0)
            .items_center()
            .radius(t.radius_md())
            .role("button")
            .cursor(Cursor::Pointer)
            .focusable(true)
            .hover(hot)
            .press_scale(0.97);
        if let Some(g) = glyph {
            b = b.child(ico(g, 14.0, t.c.muted_foreground).group_color(t.c.foreground));
        }
        b.child(text(label.to_string()).font(font(14.0, 500.0)).color(t.c.muted_foreground).group_color(t.c.foreground))
    };
    let mut bar = row().key(key).min_h(26.0).gap(6.0).items_center();
    if !s.selecting {
        return bar.child(seg(format!("{key}-select"), Some(&i::CHECK), "Select").on_press(on_toggle));
    }
    bar = bar
        .child(
            text(format!("{} selected", s.selected))
                .font(tnum(font(12.0, 400.0)))
                .color(t.c.muted_foreground)
                .max_w(220.0),
        )
        .child(seg(format!("{key}-all"), None, if s.all_selected { "Deselect all" } else { "Select all" }).on_press(on_select_all));
    let export = seg(format!("{key}-export"), Some(&i::DOWNLOAD), "Export files");
    bar = bar.child(if s.some_selected { export } else { export.opacity(0.5).disabled(true) });
    bar.child(
        el().key(format!("{key}-close"))
            .size(26.0, 26.0)
            .radius(t.radius_md())
            .center()
            .role("button")
            .label("Clear selection")
            .cursor(Cursor::Pointer)
            .hover(hot)
            .child(ico(&i::X, 16.0, t.c.muted_foreground).group_color(t.c.foreground))
            .on_press(on_clear),
    )
}

/// The track context menu at `at` (window points), for `track` in `queue`.
// TODO(components-merge): overlays::track_menu::open (with the selection).
pub fn open_track_menu(_app: &mut App, _track: TrackListItem, _queue: Vec<TrackListItem>, _at: [f32; 2]) {}
