//! `MediaCard.tsx`, `PlaylistCard.tsx` and `TopArtist.tsx` (`cards.css`):
//! the cover-art tile Home, Replay, the library grids and the playlists page
//! share, its loading stand-ins, and the playlist tile.

use std::rc::Rc;

use rune::{Cursor, El, col, el, row, text};

use crate::api::{Playlist, Visibility, media};
use crate::app::App;
use crate::images::Images;
use crate::theme::{Density, Theme};
use crate::ui::{font, ico, icons as i, line, motion};
use crate::ui::ShadowMd;

/// A press handler a card keeps (`onPlay`).
pub type Action = Rc<dyn Fn(&mut App)>;

/// `CoverArt` filling its box's width as a square (`.card-art`):
/// the image, the muted surface while it loads, or the letter.
pub fn square_art(t: &Theme, images: &Images, url: Option<&str>, label: &str, radius: f32) -> El {
    // `font-size: clamp(16px, 32%, 40px)`: a percentage of the inherited
    // 14 px, so the letter is 16 px.
    crate::ui::widgets::cover(t, images, url, label, crate::ui::widgets::CoverBox::Square, radius, 16.0)
}

/// `.card`'s padding, gap and type for the density.
pub fn card_metrics(t: &Theme) -> (f32, f32, f32) {
    if t.density == Density::Dense { (6.0, 8.0, 12.0) } else { (8.0, 10.0, 14.0) }
}

/// `.card`: the tile box, lit on hover.
pub fn card_box(t: &Theme, key: &str) -> El {
    let (pad, gap, _) = card_metrics(t);
    col()
        .key(key)
        .w_full()
        .min_w(0.0)
        .padding(pad)
        .gap(gap)
        .radius(t.radius_xl())
        .cursor(Cursor::Pointer)
        .hover(t.c.ghost_hover)
        .hover_motion(motion::ease(140.0), motion::ease(140.0))
}

/// `.card-title` and `.card-sub`.
pub fn card_text(t: &Theme, title: El, sub: Option<&str>) -> El {
    let (_, _, title_fs) = card_metrics(t);
    let mut c = col().w_full().min_w(0.0).child(crate::ui::exact(title.w_full(), title_fs * 1.45).shrink());
    if let Some(s) = sub {
        c = c.child(crate::ui::exact(line(s, font(12.0, 400.0), t.c.muted_foreground), 17.4).shrink());
    }
    c
}

/// The round primary disc a play (or open) glyph sits in: `.card-play`,
/// `.board-play`, `TopArtistGlyph`.
pub fn disc(t: &Theme, icon: &'static rune::Icon, circle: f32, glyph: f32) -> El {
    el().size(circle, circle).radius(999.0).fill(t.c.primary).center().child(ico(icon, glyph, t.c.primary_foreground))
}

/// `.card-play`: the round play button over the cover's corner, risen into
/// view while the card is hovered.
pub fn card_play(t: &Theme, key: &str, label: &str, on_play: Action) -> El {
    disc(t, &i::PLAY_FILLED, 32.0, 16.0)
        .key(key)
        .role("button")
        .label(label)
        .cursor(Cursor::Pointer)
        .shadow_md(t)
        .group_opacity(0.0, 1.0)
        .press_scale(0.95)
        .on_press(move |app: &mut App| on_play(app))
}

/// `MediaCard`'s props.
pub struct MediaCard {
    pub key: String,
    /// The page it opens (`to`).
    pub to: Option<String>,
    pub cover: Option<String>,
    pub title: String,
    pub subtitle: Option<String>,
    /// Drawn over the cover (Replay's ranks).
    pub rank_badge: Option<El>,
    pub on_play: Option<Action>,
    pub play_label: Option<String>,
}

impl MediaCard {
    pub fn new(key: impl Into<String>, title: impl Into<String>) -> MediaCard {
        MediaCard {
            key: key.into(),
            to: None,
            cover: None,
            title: title.into(),
            subtitle: None,
            rank_badge: None,
            on_play: None,
            play_label: None,
        }
    }
    pub fn to(mut self, href: impl Into<String>) -> Self {
        self.to = Some(href.into());
        self
    }
    pub fn cover(mut self, url: Option<String>) -> Self {
        self.cover = url;
        self
    }
    pub fn subtitle(mut self, s: impl Into<String>) -> Self {
        self.subtitle = Some(s.into());
        self
    }
    pub fn rank_badge(mut self, badge: El) -> Self {
        self.rank_badge = Some(badge);
        self
    }
    pub fn on_play(mut self, label: impl Into<String>, f: impl Fn(&mut App) + 'static) -> Self {
        self.play_label = Some(label.into());
        self.on_play = Some(Rc::new(f));
        self
    }

    /// The tile; size its width from the grid or shelf it sits in.
    pub fn build(self, app: &App, t: &Theme) -> El {
        let (_, _, title_fs) = card_metrics(t);
        let mut art = el().w_full().child(square_art(t, &app.images, self.cover.as_deref(), &self.title, t.radius_lg()));
        if let Some(b) = self.rank_badge {
            art = art.child(b);
        }
        if let Some(play) = self.on_play {
            let lbl = self.play_label.clone().unwrap_or_else(|| "Play".into());
            let button = card_play(t, &format!("{}-play", self.key), &lbl, play);
            let button = crate::ui::tooltip::tip(button, &format!("{}-play", self.key), &lbl);
            art = art.child(el().pin(None, None, Some(8.0), Some(8.0)).child(button));
        }
        let title = line(self.title.clone(), font(title_fs, 500.0), t.c.foreground);
        let mut card = card_box(t, &self.key).child(art).child(card_text(t, title, self.subtitle.as_deref()));
        if let Some(href) = self.to {
            card = card.focusable(true).role("link").label(self.title.clone()).on_press(move |app: &mut App| app.navigate_to(&href));
        }
        card
    }
}

/// A [`MediaCard`]'s height at `width` (`.card`: its padding, the square
/// cover, the gap and the title and subtitle lines).
pub fn media_card_height(t: &Theme, width: f32) -> f32 {
    let (_, gap, title_fs) = card_metrics(t);
    width + gap + title_fs * 1.45 + 17.4
}

/// `.replay-rank`: a play-count rank over a card's cover corner
/// ([`MediaCard::rank_badge`]).
pub fn replay_rank(t: &Theme, rank: usize) -> El {
    let style = crate::ui::tnum(font(12.0, 500.0));
    el().absolute(6.0, 6.0)
        .min_w(20.0)
        .h(20.0)
        .px(6.0)
        .radius(999.0)
        .fill(t.c.background)
        .center()
        .child(crate::ui::centred(text(rank.to_string()).font(style).color(t.c.foreground), style))
}

/// `MediaCardPlaceholders`: stand-ins for a loading row of cards, the same
/// box as a real one.
pub fn media_card_placeholders(t: &Theme, key: &str, count: usize) -> Vec<El> {
    let (pad, gap, title_fs) = card_metrics(t);
    (0..count)
        .map(|n| {
            // `.skeleton-text`: a 0.75 em bar at `vertical-align: middle`.
            let bar = |fs: f32, frac: f32| crate::ui::skeleton_line(t, fs, fs * 1.45, frac);
            col()
                .key(format!("{key}-{n}"))
                .w_full()
                .min_w(0.0)
                .padding(pad)
                .gap(gap)
                .a11y_hidden()
                .child(el().w_full().aspect_ratio(1.0).radius(t.radius_lg()).fill(t.c.muted))
                .child(col().w_full().child(bar(title_fs, 0.7)).child(bar(12.0, 0.45)))
        })
        .collect()
}

/// `playlistSubtitle`: "Private", "Collaborative · editor".
pub fn playlist_subtitle(p: &Playlist) -> String {
    crate::core::playlist_details::playlist_subtitle(p.visibility, p.effective_role)
}

/// `PlaylistCard`: a playlist's tile, the same on Home and the Playlists page.
pub fn playlist_card(app: &App, t: &Theme, p: &Playlist) -> El {
    let key = format!("playlist-card-{}", p.id);
    let (_, _, title_fs) = card_metrics(t);
    let art_url = media::playlist_art(p, Some(384));
    let art = match &art_url {
        Some(u) => square_art(t, &app.images, Some(u), &p.name, t.radius_lg()),
        None => el()
            .w_full()
            .aspect_ratio(1.0)
            .radius(t.radius_lg())
            .fill(t.c.muted)
            .center()
            .child(ico(&i::LIST_MUSIC, 32.0, t.c.muted_foreground)),
    };
    let glyph = if p.visibility == Visibility::Collaborative { &i::USERS } else { &i::LOCK };
    let title = row()
        .w_full()
        .gap(6.0)
        .items_center()
        .child(line(p.name.clone(), font(title_fs, 500.0), t.c.foreground).grow(1.0))
        .child(ico(glyph, 12.0, t.c.muted_foreground));
    let href = format!("/playlists/{}", p.id);
    card_box(t, &key)
        .focusable(true)
        .role("link")
        .label(p.name.clone())
        .child(art)
        .child(card_text(t, title, Some(&playlist_subtitle(p))))
        .on_press(move |app: &mut App| app.navigate_to(&href))
}

/// What a top artist's tile does (`topArtistAction`).
pub use crate::core::replay::figures::TopArtistAction;

/// `artistHref`: a library artist's page.
pub fn artist_href(id: &str) -> String {
    format!("/library?view=artists&artist={}", urlencoding::encode(id))
}

/// `TopArtistGlyph`: the arrow (opens a page) or the play triangle (plays),
/// drawn over the picture on hover. `circle` is its backdrop's size.
pub fn top_artist_glyph(t: &Theme, action: Option<TopArtistAction>, circle: f32, glyph: f32) -> Option<El> {
    let icon = match action? {
        TopArtistAction::Open => &i::ARROW_RIGHT,
        TopArtistAction::Play => &i::PLAY_FILLED,
    };
    Some(disc(t, icon, circle, glyph).group_opacity(0.0, 1.0).a11y_hidden())
}

/// `TopArtistName`'s press: open the artist's page, or play them.
pub fn top_artist_press(e: El, action: Option<TopArtistAction>, artist_id: &str, name: &str, on_play: Action) -> El {
    match action {
        Some(TopArtistAction::Open) => {
            let href = artist_href(artist_id);
            e.role("link").label(format!("Open {name}")).cursor(Cursor::Pointer).on_press(move |app: &mut App| app.navigate_to(&href))
        }
        Some(TopArtistAction::Play) => e.role("button").label(format!("Play {name}")).cursor(Cursor::Pointer).on_press(move |app: &mut App| on_play(app)),
        None => e.cursor(Cursor::Default),
    }
}
