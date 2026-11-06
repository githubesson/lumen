//! The playlist page's header (`PlaylistDetail.tsx`'s `ListPageHeader`
//! slots and `PlaylistHeaderArt`; `detail.css`).

use rune::{Color, Cursor, Cx, El, TextStyle, col, el, row, text};

use crate::api::{Playlist, PlaylistTrackEntry, TrackListItem, Visibility, media};
use crate::app::App;
use crate::images::Cover;
use crate::theme::Theme;
use crate::ui::{Btn, font, ico, icons as i, motion, with_lh};

use super::adapters::{self, Header};
use super::detail;
use super::logic::{self, Permissions, pluralize};

/// `text-wrap: balance`: the narrowest width (up to `max`) that keeps the
/// lines `text` takes at `max`, so they come out even.
pub fn balanced_width(s: &str, style: TextStyle, max: f32) -> f32 {
    let lines = |w: f32| {
        let (_, h) = rune::text::measure(s, &[], style, Some(w));
        (h / style.line_height).round().max(1.0)
    };
    let n = lines(max);
    if n <= 1.0 {
        return max;
    }
    let (mut lo, mut hi) = (max / n, max);
    for _ in 0..12 {
        let mid = (lo + hi) / 2.0;
        if lines(mid) > n { lo = mid } else { hi = mid }
    }
    hi.ceil().min(max)
}

/// `.detail-title`'s style: 36 px semibold, tight.
fn title_style() -> TextStyle {
    with_lh(font(36.0, 600.0), 39.6).tracking(-0.9)
}

/// The header art's picture: the custom cover, else the first track's.
fn art_url(p: &Playlist, first: Option<&TrackListItem>) -> Option<String> {
    match p.custom_cover.as_deref().filter(|v| !v.is_empty()) {
        Some(v) => Some(media::playlist_cover_path(&p.id, v, Some(400))),
        None => first.map(|t| media::track_cover(&t.id, t.album_id.as_deref(), t.cover_url.as_deref(), None)),
    }
}

/// `PlaylistHeaderArt`: a 200 px tile; for the owner a button that picks a
/// new cover, with a hint over it on hover (and while uploading).
fn art(app: &App, t: &Theme, p: &Playlist, first: Option<&TrackListItem>, tracks_known: bool, editable: bool, saving: bool) -> El {
    let r = t.radius_lg();
    let url = art_url(p, first);
    let mut tile = el().key("playlist-art").size(200.0, 200.0).radius(r).fill(t.c.muted).clip_rounded(r).center();
    match url.as_deref().map(|u| app.images.get(u)) {
        Some(Cover::Ready(img)) => tile = tile.child(el().size(200.0, 200.0).absolute(0.0, 0.0).pixels_fit(img.pixels(), rune::SurfaceFit::Fill)),
        Some(_) => {}
        None if tracks_known => tile = tile.child(ico(&i::MUSIC, 48.0, t.c.muted_foreground)),
        None => {}
    }
    if !editable {
        return tile;
    }
    let hint = col()
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .center()
        .gap(6.0)
        .fill(rune::oklcha(0.0, 0.0, 0.0, 0.55))
        .child(ico(&i::IMAGE_UP, 20.0, Color::WHITE))
        .child(text(if saving { "Uploading…" } else { "Choose image" }).font(font(13.0, 500.0)).color(Color::WHITE))
        .inert();
    let hint = if saving { hint } else { hint.group_opacity(0.0, 1.0).opacity_motion(motion::ease(150.0)) };
    tile = tile.child(hint).role("button").label("Choose cover image").hover_group();
    if saving {
        tile.disabled(true).cursor(Cursor::Default)
    } else {
        tile.cursor(Cursor::Pointer).focusable(true).on_press_tx(|app: &mut App, tx| detail::pick_cover(app, tx))
    }
}

/// The kind line: the visibility with its icon, then your role on someone
/// else's playlist.
fn kind(t: &Theme, p: &Playlist, perms: &Permissions) -> El {
    let ink = t.c.muted_foreground;
    let style = font(12.0, 500.0);
    let (glyph, label) =
        if p.visibility == Visibility::Collaborative { (&i::USERS, "Collaborative") } else { (&i::LOCK, "Private") };
    // An inline-flex box starting with an icon sits on the icon's bottom
    // edge, so it rides 1.6 px above the plain text after it.
    let mut k = row()
        .items_start()
        .child(row().gap(4.0).items_center().child(ico(glyph, 12.0, ink)).child(text(label).font(style).color(ink)));
    let role = logic::role_name(perms.role);
    if !role.is_empty() && !perms.is_owner {
        k = k
            .child(text("·").font(style).color(ink).mx(8.0).mt(1.6))
            .child(text(role).font(style).color(ink).mt(1.6));
    }
    k
}

/// `.detail-meta`: the count, the length and what's queued, dot-separated.
fn meta(t: &Theme, tracks: Option<&[PlaylistTrackEntry]>, queued: Option<u32>) -> El {
    let ink = t.c.muted_foreground;
    let item = |s: String| text(s).font(font(14.0, 400.0)).color(ink);
    let dot = || el().size(3.0, 3.0).radius(99.0).fill(ink);
    let mut m = row().gap(8.0).items_center().flex_wrap();
    match tracks {
        None => m = m.child(item("—".into())),
        Some(rows) => {
            m = m.child(item(pluralize(rows.len(), "track")));
            if !rows.is_empty() {
                let total: u64 = rows.iter().map(|r| r.duration_ms).sum();
                m = m.child(dot()).child(item(crate::format::fmt_total_ms(total)));
            }
        }
    }
    if let Some(n) = queued.filter(|n| *n > 0) {
        m = m.child(dot()).child(item(format!("{n} queued for download")));
    }
    m
}

pub struct Props<'a> {
    pub playlist: &'a Playlist,
    pub perms: Permissions,
    pub tracks: Option<&'a [PlaylistTrackEntry]>,
    pub queue: Vec<TrackListItem>,
    pub first_cover: Option<TrackListItem>,
    pub queued: Option<u32>,
    pub saving_cover: bool,
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>, h: Props) -> El {
    let p = h.playlist;
    // The body's width: the header's, less the padding, art and gap.
    let body_w = cx.layout_size("playlist-header").map_or(956.0, |s| s[0]) - 50.0 - 200.0 - 24.0;
    let width = balanced_width(&p.name, title_style(), body_w.max(1.0));
    let title_text = text(p.name.clone()).font(title_style()).color(t.c.card_foreground).wrap_anywhere().max_w(width);
    let title = if h.perms.can_edit_details {
        el().radius(t.radius_sm())
            .role("button")
            .label(p.name.clone())
            .help("Edit details")
            .cursor(Cursor::Pointer)
            .focusable(true)
            .on_press(detail::open_settings_on_name)
            .child(title_text)
    } else {
        el().child(title_text)
    };
    let mut actions = row().gap(8.0).items_center().flex_wrap().child(adapters::play_list_button(
        t,
        "playlist-play-all",
        h.queue,
        h.tracks.is_none_or(|r| r.is_empty()),
        "Play all",
    ));
    if h.perms.can_edit_tracks {
        let add = Btn::new("playlist-add-tracks", "Add tracks").icon(&i::PLUS).icon_size(16.0).disabled(h.tracks.is_none()).build(t);
        actions = actions.child(if h.tracks.is_none() { add } else { add.on_press(super::add_tracks::open) });
    }
    let header = adapters::list_page_header(
        t,
        Header {
            kind: kind(t, p, &h.perms),
            title: title.mt(6.0).mb(10.0),
            description: p.description.clone().filter(|d| !d.is_empty()),
            art: art(app, t, p, h.first_cover.as_ref(), h.tracks.is_some(), h.perms.can_change_cover, h.saving_cover),
            meta: Some(meta(t, h.tracks, h.queued)),
            actions: Some(actions),
        },
    );
    header.key("playlist-header")
}
