//! Jump back in (`ResumePanel`, `HeroAlbum`, `HeroTracks` in
//! `HomePanels.tsx`; `.hero` in `home.css`, `.board-resume` in `board.css`):
//! the album of the last track you played (or, before you've played
//! anything, a library track), a placeholder of the same shape while that
//! loads, or a welcome for an empty library. When its slot has room under
//! the cover, the album's tracks fill it.

use std::rc::Rc;

use rune::{El, TextStyle, col, el, row, text};

use crate::api::TrackListItem;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::{Btn, cover_art, font, icons as i, line, with_lh};

use super::arrangement::HomePanel;
use super::board::{self, TrackRow};
use super::fill::{BOARD_ROW_HEIGHT, FillUsual, count_in};
use super::logic::{self, album_href, display_text, track_album_target, track_cover_url};
use super::panels::{Ctx, Out, tracks_label};

/// `.hero-art`'s side on a wide window.
const ART: f32 = 168.0;
/// `.board-resume-head`'s gap (and its row gap once the text wraps under).
const GAP: f32 = 24.0;

fn eyebrow_style() -> TextStyle {
    font(12.0, 500.0)
}
/// `.board-resume .hero-title`: 24 px semibold, -0.025em, line-height 1.15.
fn title_style() -> TextStyle {
    with_lh(font(24.0, 600.0), 27.6).tracking(-0.6)
}

fn lines_height(s: &str, style: TextStyle, width: f32) -> f32 {
    rune::text::measure_with(s, &[], style, Some(width), rune::text::RichLayoutOptions::new().wrap_anywhere()).1
}

/// `text-wrap: balance`: the narrowest width that keeps the text on as few
/// lines as `width` gives it, so the lines come out even.
fn balanced_width(s: &str, style: TextStyle, width: f32) -> f32 {
    let h = lines_height(s, style, width);
    if h <= style.line_height + 0.5 {
        return width;
    }
    let (mut lo, mut hi) = (0.0f32, width);
    while hi - lo > 0.5 {
        let mid = (lo + hi) / 2.0;
        if lines_height(s, style, mid) <= h + 0.5 { hi = mid } else { lo = mid }
    }
    hi.ceil()
}

/// What the hero's text says.
struct Body {
    eyebrow: Option<String>,
    /// None: the loading skeleton.
    title: Option<String>,
    meta: Vec<String>,
    actions: Vec<El>,
    /// Loading: the meta line is a status.
    status_meta: bool,
    /// The note under the title when nothing loaded.
    note: Option<String>,
}

/// The text block's width and height, and how the head is laid out.
struct HeadLayout {
    /// The art's side, None without art.
    art: Option<f32>,
    /// The text sits under the art (a narrow window, or a slot too narrow
    /// for the two side by side).
    stacked: bool,
    body_w: f32,
    body_h: f32,
    head_h: f32,
}

fn body_height(b: &Body, w: f32, narrow: bool) -> f32 {
    let mut h = 0.0;
    if b.eyebrow.is_some() {
        h += 17.4 + 6.0;
    }
    h += match &b.title {
        Some(t) => (lines_height(t, title_style(), w) / 27.6).round().max(1.0) * 27.6,
        None => 27.6,
    } + 6.0;
    if let Some(n) = &b.note {
        h += (rune::text::measure(n, &[], font(14.0, 400.0), Some(w)).1 / 20.3).round().max(1.0) * 20.3;
    }
    if !b.meta.is_empty() {
        // `.hero-meta` wraps on a narrow window.
        let one = meta_width(&b.meta);
        let lines = if narrow && one > w { 2.0 } else { 1.0 };
        h += 20.3 * lines + 16.0;
    }
    if !b.actions.is_empty() {
        h += 32.0;
    }
    h
}

fn meta_width(meta: &[String]) -> f32 {
    let words: f32 = meta.iter().map(|m| rune::text::measure(m, &[], font(14.0, 400.0), None).0).sum();
    words + (meta.len().saturating_sub(1)) as f32 * (8.0 + 3.0 + 8.0)
}

fn head_layout(b: &Body, content: f32, with_art: bool, narrow: bool) -> HeadLayout {
    if !with_art {
        let body_h = body_height(b, content, narrow);
        return HeadLayout { art: None, stacked: false, body_w: content, body_h, head_h: body_h };
    }
    if narrow {
        let art = content.min(220.0);
        let body_h = body_height(b, content, narrow);
        return HeadLayout { art: Some(art), stacked: true, body_w: content, body_h, head_h: art + GAP + body_h };
    }
    // `flex: 1 1 220px` beside the cover, wrapping under it when there's no room.
    let beside = content - ART - GAP;
    if beside >= 220.0 {
        let body_h = body_height(b, beside, narrow);
        HeadLayout { art: Some(ART), stacked: false, body_w: beside, body_h, head_h: body_h.max(ART) }
    } else {
        let body_h = body_height(b, content, narrow);
        HeadLayout { art: Some(ART), stacked: true, body_w: content, body_h, head_h: ART + GAP + body_h }
    }
}

fn dot(t: &Theme) -> El {
    el().size(3.0, 3.0).radius(99.0).fill(t.c.muted_foreground)
}

fn body_view(t: &Theme, b: Body, l: &HeadLayout, narrow: bool) -> El {
    let mut c = col().w(l.body_w).min_w(0.0);
    if let Some(e) = &b.eyebrow {
        c = c.child(board::lh(line(e.clone(), eyebrow_style(), t.c.muted_foreground), 17.4).mb(6.0));
    }
    c = c.child(match &b.title {
        Some(title) => {
            let w = if narrow { l.body_w } else { balanced_width(title, title_style(), l.body_w) };
            let h = lines_height(title, title_style(), l.body_w);
            let h = (h / 27.6).round().max(1.0) * 27.6;
            board::lh(text(title.clone()).font(title_style()).color(t.c.card_foreground).wrap_anywhere().max_w(w), h).mb(6.0)
        }
        None => {
            let ch = rune::text::advance("0", title_style());
            let bar = 24.0 * 0.75;
            let mid = board::baseline(24.0, 27.6) - 24.0 * 0.53 / 2.0;
            el().w_full().h(27.6).mb(6.0).child(el().absolute(0.0, mid - bar / 2.0).w(12.0 * ch).h(bar).radius(t.radius_sm()).fill(t.c.muted))
        }
    });
    if let Some(n) = &b.note {
        let h = rune::text::measure(n, &[], font(14.0, 400.0), Some(l.body_w)).1;
        c = c.child(board::lh(text(n.clone()).font(font(14.0, 400.0)).color(t.c.card_foreground).wrap(), (h / 20.3).round().max(1.0) * 20.3));
    }
    if !b.meta.is_empty() {
        let mut m = row().gap(8.0).items_center().mb(16.0);
        if narrow {
            m = m.flex_wrap();
        }
        for (n, part) in b.meta.iter().enumerate() {
            if n > 0 {
                m = m.child(dot(t));
            }
            let mut p = text(part.clone()).font(font(14.0, 400.0)).color(t.c.muted_foreground);
            if b.status_meta {
                p = p.role("status");
            }
            m = m.child(board::lh(p, 20.3));
        }
        c = c.child(m);
    }
    if !b.actions.is_empty() {
        let mut a = row().gap(8.0).items_center().flex_wrap();
        for btn in b.actions {
            a = a.child(btn);
        }
        c = c.child(a);
    }
    c
}

/// `.hero.board-resume`.
fn shell(t: &Theme, key: &str, w: f32, h: f32) -> El {
    let r = t.radius_xl();
    crate::ui::css_border(col(), 1.0, t.c.border, r)
        .key(key.to_string())
        .w(w)
        .h(h)
        .padding(17.0)
        .radius(r)
        .fill(t.c.card)
        .clip_rounded(r)
        .justify_end()
}

fn head_view(art: Option<El>, body: El, l: &HeadLayout) -> El {
    match (art, l.stacked) {
        (None, _) => body,
        (Some(a), true) => col().w_full().gap(GAP).items_start().child(a).child(body),
        (Some(a), false) => row().w_full().gap(GAP).items_end().child(a).child(body),
    }
}

pub fn resume(app: &App, t: &Theme, ctx: &Ctx, p: &HomePanel, w: f32, h: Option<f32>) -> Out {
    let st = ctx.state;
    let content = board::content_width(w);
    let narrow = ctx.narrow_window;
    let key = format!("panel-{}", p.id);
    if let Some(track) = &ctx.hero {
        return hero_album(app, t, ctx, p, track, w, h);
    }
    if st.recent.loading || st.tracks.loading {
        let body = Body {
            eyebrow: Some(p.title.clone().unwrap_or_else(|| "Jump back in".into())),
            title: None,
            meta: vec!["Loading your music…".into()],
            actions: vec![
                board::button16(t, Btn::new(format!("{key}-play"), "Play").primary().disabled(true), &i::PLAY_FILLED),
                board::button16(t, Btn::new(format!("{key}-open"), "Open album").disabled(true), &i::DISC_3),
            ],
            status_meta: true,
            note: None,
        };
        let l = head_layout(&body, content, true, narrow);
        let natural = 34.0 + l.head_h;
        let Some(h) = h else { return Out { natural, view: None, want: None } };
        let side = l.art.unwrap_or(ART);
        let art = el().size(side, side).radius(t.radius_lg()).fill(t.c.muted).a11y_hidden();
        let art = if l.stacked && narrow { el().w_full().center().child(art) } else { art };
        let head = head_view(Some(art), body_view(t, body, &l, narrow), &l);
        return Out { natural, view: Some(shell(t, &key, w, h).child(head)), want: None };
    }
    let body = if st.recent.error.is_some() || st.tracks.error.is_some() {
        Body {
            eyebrow: None,
            title: Some("Your library".into()),
            meta: vec![],
            actions: vec![],
            status_meta: false,
            note: Some("Some music could not be loaded. Retry the sections below.".into()),
        }
    } else {
        let name = app.me().map(|m| m.username.clone()).unwrap_or_default();
        Body {
            eyebrow: Some(format!("Welcome, {name}")),
            title: Some("Your library is quiet".into()),
            meta: vec!["Nothing ingested yet".into()],
            actions: vec![
                board::button16(t, Btn::new(format!("{key}-explore"), "Explore").primary(), &i::SPARKLES)
                    .role("link")
                    .on_press(|app: &mut App| app.navigate_to("/library")),
            ],
            status_meta: false,
            note: None,
        }
    };
    let l = head_layout(&body, content, false, narrow);
    let natural = 34.0 + l.head_h;
    let Some(h) = h else { return Out { natural, view: None, want: None } };
    Out { natural, view: Some(shell(t, &key, w, h).child(body_view(t, body, &l, narrow))), want: None }
}

/// `HeroAlbum`: the album, with Play picking up from the track you were on,
/// and as many of its tracks as the slot has room for.
fn hero_album(app: &App, t: &Theme, ctx: &Ctx, p: &HomePanel, track: &TrackListItem, w: f32, h: Option<f32>) -> Out {
    let st = ctx.state;
    let content = board::content_width(w);
    let narrow = ctx.narrow_window;
    let key = format!("panel-{}", p.id);
    let target = track_album_target(track);
    // Only a library album has a page to describe it and tracks to play
    // through here; a TIDAL track links to its release.
    let album_id = target.as_ref().filter(|t| !t.tidal).map(|t| t.id.clone());
    let album = album_id.as_ref().and_then(|id| st.hero_album.get(id)).and_then(|r| r.data.as_ref());
    let year = album.and_then(|a| a.release_year).filter(|y| *y != 0);
    let track_count = album.map(|a| a.track_count).filter(|n| *n > 0);
    let from_recent = st.recent.data.as_ref().is_some_and(|r| !r.is_empty());
    let mut meta = vec![display_text(track.artist.as_deref(), "Unknown artist")];
    if let Some(y) = year {
        meta.push(y.to_string());
    }
    if let Some(n) = track_count {
        meta.push(tracks_label(n));
    }
    let mut actions = vec![{
        let tr = track.clone();
        board::button16(t, Btn::new(format!("{key}-play"), "Play").primary().disabled(st.hero_starting), &i::PLAY_FILLED)
            .on_press(move |app: &mut App| super::play_hero(app, &tr))
    }];
    if let Some(href) = target.as_ref().map(album_href) {
        actions.push(
            board::button16(t, Btn::new(format!("{key}-open"), "Open album"), &i::DISC_3)
                .role("link")
                .on_press(move |app: &mut App| app.navigate_to(&href)),
        );
    }
    let title_text = display_text(Some(track.album_title.as_deref().unwrap_or(&track.title)), "");
    let body = Body {
        eyebrow: Some(p.title.clone().unwrap_or_else(|| (if from_recent { "Jump back in" } else { "From your library" }).into())),
        title: Some(title_text),
        meta,
        actions,
        status_meta: false,
        note: None,
    };
    let l = head_layout(&body, content, true, narrow);
    let fixed = 34.0 + l.head_h;
    // None in its usual slot, where the hero is as tall as its row.
    let tracks_res = album_id.as_ref().and_then(|id| st.hero_tracks.get(id));
    let listed: &[TrackListItem] = tracks_res.and_then(|r| r.data.as_deref()).unwrap_or(&[]);
    let natural = fixed;
    let Some(h) = h else { return Out { natural, view: None, want: None } };
    let rows = count_in(FillUsual::Count(0), h - fixed, 1, BOARD_ROW_HEIGHT, 0.0, 12.0, listed.len());
    let show_tracks = album_id.is_some() && rows > 0;
    let label = track.album_title.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| track.title.clone());
    let side = l.art.unwrap_or(ART);
    let art = cover_art(t, &app.images, Some(&track_cover_url(track, None)), &label, side, side, t.radius_lg());
    let art = if l.stacked && narrow { el().w_full().center().child(art) } else { art };
    let head = head_view(Some(art), body_view(t, body, &l, narrow), &l);
    let mut hero = shell(t, &key, w, h);
    if show_tracks {
        let list = hero_tracks(app, t, &key, track, album_id.as_deref().unwrap_or_default(), rows, track_count, tracks_res, content);
        hero = hero.justify_start().child(head).child(list);
    } else {
        hero = hero.child(head);
    }
    // Room for tracks: the view's effects load the album's list.
    let want = show_tracks.then_some(rows);
    Out { natural, view: Some(hero), want }
}

/// `HeroTracks`: the album's tracks from the one you were on (or fewer
/// before it near the album's end). A row plays the album from there.
#[allow(clippy::too_many_arguments)]
fn hero_tracks(
    app: &App,
    t: &Theme,
    key: &str,
    track: &TrackListItem,
    album_id: &str,
    rows: usize,
    track_count: Option<u32>,
    res: Option<&super::Res<Vec<TrackListItem>>>,
    content: f32,
) -> El {
    let tracks: &[TrackListItem] = res.and_then(|r| r.data.as_deref()).unwrap_or(&[]);
    let list_key = format!("{key}-tracks");
    if tracks.is_empty() {
        let loading = res.is_none_or(|r| r.loading);
        if loading {
            let n = rows.min(track_count.map_or(rows, |c| c as usize));
            let mut c = col().key(list_key.clone()).w(content + 16.0).ml(-8.0).mt(12.0).a11y_hidden();
            for r in board::row_placeholders(t, &list_key, n, true, true) {
                c = c.child(r);
            }
            return c;
        }
        let mut c = col().w_full().mt(12.0);
        if let Some(e) = res.and_then(|r| r.error.clone()) {
            let id = album_id.to_string();
            c = c.child(
                row().w_full().gap(8.0).pt(8.0).items_center().role("status")
                    .child(line(e.clone(), font(14.0, 400.0), t.c.muted_foreground).help(e).shrink())
                    .child(
                        Btn::new(format!("{key}-tracks-retry"), "Retry")
                            .small()
                            .build(t)
                            .label("Retry the album's tracks")
                            .on_press(move |app: &mut App| super::sources::load_hero_tracks(app, &id)),
                    ),
            );
        }
        return c;
    }
    let at = tracks.iter().position(|x| x.id == track.id).unwrap_or(0);
    let start = at.min(tracks.len().saturating_sub(rows));
    let queue = Rc::new(logic::playable_tracks(tracks));
    let all = Rc::new(tracks.to_vec());
    let items: Vec<El> = tracks
        .iter()
        .skip(start)
        .take(rows)
        .enumerate()
        .map(|(n, x)| {
            let (q, tr) = (queue.clone(), x.clone());
            board::track_row(app, t, format!("{list_key}-{n}"), x, TrackRow {
                ranked: true,
                rank: start + n + 1,
                bare: true,
                current: x.id == track.id,
                meta: crate::format::fmt_duration_ms(x.duration_ms),
                on_play: Rc::new(move |app: &mut App| super::play_from(app, &tr, &q)),
                queue: all.clone(),
            })
        })
        .collect();
    // Not a board panel: always one column.
    let mut c = col().key(list_key).w(content + 16.0).ml(-8.0).mt(12.0);
    for r in items {
        c = c.child(r);
    }
    c
}
