//! Stand-ins for the shared components another agent is building, so Home
//! renders before they merge: `MediaCard` / `MediaCardPlaceholders`,
//! `TopArtistGlyph` / `TopArtistName`, `ActivityChart`, the track context
//! menu (`useTrackContextMenu`) and tooltips.
//!
//! TODO(components-merge): rewrite each function here as a call to the
//! shared one (`crate::ui::cards::MediaCard`, `media_card_placeholders`,
//! `top_artist_glyph`, `top_artist_press`, `crate::ui::chart::activity_chart`,
//! `crate::overlays::track_menu::open`, `crate::ui::tooltip::tip`) and keep
//! the signatures, which is all Home calls.

use std::rc::Rc;

use rune::{Color, Cursor, El, Shadow, col, el, row, text};

use crate::api::TrackListItem;
use crate::app::App;
use crate::theme::{Density, Theme};
use crate::ui::{cover_art, font, ico, icons as i, line};

use super::logic::TopArtistAction;
use super::requests::{ReplayActivityBucket, ReplayBucket};

pub type Action = Rc<dyn Fn(&mut App)>;

/// `.card`'s padding, gap and title size (dense boards tighten them).
pub fn card_metrics(t: &Theme) -> (f32, f32, f32) {
    if t.density == Density::Dense { (6.0, 8.0, 12.0) } else { (8.0, 10.0, 14.0) }
}

/// A `MediaCard`'s height at `width`: padding, the square cover, the gap,
/// and the title and subtitle lines.
pub fn card_height(t: &Theme, width: f32) -> f32 {
    let (pad, gap, title) = card_metrics(t);
    width - 2.0 * pad + 2.0 * pad + gap + crate::ui::font(title, 500.0).line_height + 17.4
}

/// `MediaCard`'s props, as Home uses them.
pub struct Card {
    pub key: String,
    pub to: String,
    pub cover: Option<String>,
    pub title: String,
    pub subtitle: String,
    /// Replay's rank over the cover's corner.
    pub rank: Option<usize>,
    pub on_play: Option<(String, Action)>,
}

/// TODO(components-merge): `MediaCard` (cards.css), a faithful sketch: the
/// cover, title and subtitle, lit on hover, opening `to`, with the round
/// play button over the cover's corner on hover.
pub fn media_card(app: &App, t: &Theme, card: Card, width: f32) -> El {
    let (pad, gap, title_fs) = card_metrics(t);
    let side = width - 2.0 * pad;
    let mut art = el()
        .size(side, side)
        .child(cover_art(t, &app.images, card.cover.as_deref(), &card.title, side, side, t.radius_lg()));
    if let Some(n) = card.rank {
        // `.replay-rank`.
        art = art.child(
            el().absolute(8.0, 8.0)
                .min_w(24.0)
                .h(24.0)
                .px(6.0)
                .radius(999.0)
                .fill(Color::BLACK.alpha(0.6))
                .center()
                .child(text(n.to_string()).font(font(12.0, 600.0)).color(Color::WHITE)),
        );
    }
    if let Some((label, play)) = card.on_play {
        let a = t.c.shadow_md_alpha;
        art = art.child(
            el().key(format!("{}-play", card.key))
                .absolute(side - 40.0, side - 40.0)
                .size(32.0, 32.0)
                .radius(999.0)
                .fill(t.c.primary)
                .center()
                .role("button")
                .label(label.clone())
                .help(label)
                .cursor(Cursor::Pointer)
                .box_shadow(Shadow { x: 0.0, y: 4.0, blur: 6.0, spread: -1.0, color: Color::BLACK.alpha(a), inset: false })
                .box_shadow(Shadow { x: 0.0, y: 2.0, blur: 4.0, spread: -2.0, color: Color::BLACK.alpha(a), inset: false })
                .group_opacity(0.0, 1.0)
                .press_scale(0.95)
                .child(ico(&i::PLAY_FILLED, 16.0, t.c.primary_foreground))
                .on_press(move |app: &mut App| play(app)),
        );
    }
    let to = card.to.clone();
    col()
        .key(card.key)
        .w(width)
        .padding(pad)
        .gap(gap)
        .radius(t.radius_xl())
        .hover(t.c.accent)
        .hover_motion(crate::ui::motion::ease(140.0), crate::ui::motion::ease(140.0))
        .role("link")
        .label(card.title.clone())
        .cursor(Cursor::Pointer)
        .child(art)
        .child(
            col()
                .w_full()
                .min_w(0.0)
                .child(line(card.title, font(title_fs, 500.0), t.c.foreground))
                .child(line(card.subtitle, font(12.0, 400.0), t.c.muted_foreground)),
        )
        .on_press(move |app: &mut App| app.navigate_to(&to))
}

/// TODO(components-merge): `MediaCardPlaceholders`.
pub fn media_card_placeholders(t: &Theme, key: &str, count: usize, width: f32) -> Vec<El> {
    let (pad, gap, title_fs) = card_metrics(t);
    let side = width - 2.0 * pad;
    (0..count)
        .map(|n| {
            col()
                .key(format!("{key}-{n}"))
                .w(width)
                .padding(pad)
                .gap(gap)
                .a11y_hidden()
                .child(el().size(side, side).radius(t.radius_lg()).fill(t.c.muted))
                .child(
                    col()
                        .w_full()
                        .child(super::board::skeleton_line(t, title_fs, title_fs * 1.45, 0.7))
                        .child(super::board::skeleton_line(t, 12.0, 17.4, 0.45)),
                )
        })
        .collect()
}

/// TODO(components-merge): `TopArtistGlyph`: the arrow (opens a page) or the
/// play triangle (plays), shown over the picture on hover. `circle` is its
/// backdrop's size (`.board-avatar .board-play`: 28 px).
pub fn top_artist_glyph(t: &Theme, action: Option<TopArtistAction>, circle: f32, glyph: f32) -> Option<El> {
    let icon = match action? {
        TopArtistAction::Open => &i::ARROW_RIGHT,
        TopArtistAction::Play => &i::PLAY_FILLED,
    };
    Some(
        el().size(circle, circle)
            .radius(999.0)
            .fill(t.c.primary)
            .center()
            .group_opacity(0.0, 1.0)
            .a11y_hidden()
            .child(ico(icon, glyph, t.c.primary_foreground)),
    )
}

/// TODO(components-merge): `TopArtistName`'s press: open the artist's page,
/// or play them.
pub fn top_artist_press(e: El, action: Option<TopArtistAction>, artist_id: &str, name: &str, on_play: Action) -> El {
    match action {
        Some(TopArtistAction::Open) => {
            let href = format!("/library?view=artists&artist={}", urlencoding::encode(artist_id));
            e.role("link").label(format!("Open {name}")).cursor(Cursor::Pointer).on_press(move |app: &mut App| app.navigate_to(&href))
        }
        Some(TopArtistAction::Play) => {
            e.role("button").label(format!("Play {name}")).cursor(Cursor::Pointer).on_press(move |app: &mut App| on_play(app))
        }
        None => e.cursor(Cursor::Default),
    }
}

/// TODO(components-merge): `ActivityChart` (`replay.css`'s
/// `.activity-chart`), a sketch: bars on a hairline, filling `h`.
pub fn activity_chart(t: &Theme, key: &str, buckets: &[ReplayActivityBucket], _bucket: ReplayBucket, h: f32) -> El {
    let max = buckets.iter().map(|b| b.plays).max().unwrap_or(0).max(1);
    let plot = (h - 8.0 - 28.0 - 1.0).max(0.0);
    let mut bars = row().key(format!("{key}-bars")).w_full().h(plot).gap(3.0).items_end().role("img").label("Listening activity");
    for b in buckets {
        let pct = b.plays as f32 / max as f32;
        bars = bars.child(
            el().grow(1.0).min_w(0.0).h((plot * pct).max(if b.plays > 0 { 2.0 } else { 0.0 })).radius(2.0).fill(t.c.primary),
        );
    }
    col()
        .key(key)
        .w_full()
        .h(h)
        .pt(8.0)
        .pb(28.0)
        .child(bars)
        .child(el().w_full().h(1.0).fill(t.c.border))
}

/// TODO(components-merge): `useTrackContextMenu().bind(track, { queue })`:
/// `crate::overlays::track_menu::open(app, track, at, MenuContext { queue,
/// ..Default::default() })`.
pub fn open_track_menu(app: &mut App, track: TrackListItem, at: [f32; 2], queue: Vec<TrackListItem>) {
    let _ = (app, track, at, queue);
}

/// TODO(components-merge): `Tooltip` (`crate::ui::tooltip::tip`).
pub fn tip(e: El, _key: &str, text: &str) -> El {
    e.help(text)
}
