//! `MediaCard.tsx`, `PlaylistCard.tsx` and `TopArtist.tsx` (`cards.css`):
//! the cover-art tile Home, Replay, the library grids and the playlists page
//! share, its loading stand-ins, and the playlist tile.

use std::rc::Rc;

use rune::{Color, Cursor, El, PointerPress, Shadow, col, el, row, text};

use crate::api::{EffectiveRole, Playlist, Visibility, media};
use crate::app::App;
use crate::images::{Cover, Images};
use crate::theme::{Density, Theme};
use crate::ui::{font, ico, icons as i, line, motion};

/// A press handler a card keeps (`onPlay`).
pub type Action = Rc<dyn Fn(&mut App)>;
/// `onContextMenu`: the press point in window points.
pub type MenuAction = Rc<dyn Fn(&mut App, PointerPress)>;

/// `CoverArt` filling its box's width as a square (`.card-art`):
/// the image, the muted surface while it loads, or the letter.
pub fn square_art(t: &Theme, images: &Images, url: Option<&str>, label: &str, radius: f32) -> El {
    let base = el().w_full().aspect_ratio(1.0).radius(radius).fill(t.c.muted).clip_rounded(radius);
    match url.map(|u| images.get(u)).unwrap_or(Cover::Failed) {
        Cover::Ready(img) => base.child(el().w_full().h_full().pixels_fit(img.pixels(), rune::SurfaceFit::Fill)),
        Cover::Loading => base,
        Cover::Failed => {
            let ch = label.trim().chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_else(|| "?".into());
            // `font-size: clamp(16px, 32%, 40px)`: a percentage of the
            // inherited 14 px, so the letter is 16 px.
            base.center().child(text(ch).font(font(16.0, 500.0)).color(t.c.muted_foreground))
        }
    }
}

/// `.card`'s padding, gap and type for the density.
fn card_metrics(t: &Theme) -> (f32, f32, f32) {
    if t.density == Density::Dense { (6.0, 8.0, 12.0) } else { (8.0, 10.0, 14.0) }
}

/// `.card`: the tile box, lit on hover.
fn card_box(t: &Theme, key: &str) -> El {
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
fn card_text(t: &Theme, title: El, sub: Option<&str>) -> El {
    let (_, _, sub_fs) = card_metrics(t);
    let (_, _, title_fs) = card_metrics(t);
    let mut c = col().w_full().min_w(0.0).child(crate::ui::exact_text(title.w_full(), title_fs, title_fs * 1.45));
    if let Some(s) = sub {
        let _ = sub_fs;
        c = c.child(crate::ui::exact_text(line(s, font(12.0, 400.0), t.c.muted_foreground), 12.0, 17.4));
    }
    c
}

/// `.card-play`: the round play button over the cover's corner, risen into
/// view while the card is hovered.
pub fn card_play(t: &Theme, key: &str, label: &str, on_play: Action) -> El {
    let a = t.c.shadow_md_alpha;
    el().key(key)
        .size(32.0, 32.0)
        .radius(999.0)
        .fill(t.c.primary)
        .center()
        .role("button")
        .label(label)
        .cursor(Cursor::Pointer)
        .box_shadow(Shadow { x: 0.0, y: 4.0, blur: 6.0, spread: -1.0, color: Color::BLACK.alpha(a), inset: false })
        .box_shadow(Shadow { x: 0.0, y: 2.0, blur: 4.0, spread: -2.0, color: Color::BLACK.alpha(a), inset: false })
        .group_opacity(0.0, 1.0)
        .press_scale(0.95)
        .child(ico(&i::PLAY_FILLED, 16.0, t.c.primary_foreground))
        .on_press(move |app: &mut App| on_play(app))
}

/// `MediaCard`'s props.
pub struct MediaCard {
    pub key: String,
    /// The page it opens (`to`).
    pub to: Option<String>,
    pub cover: Option<String>,
    /// The placeholder's letter source (defaults to the title).
    pub art_label: Option<String>,
    pub title: String,
    pub subtitle: Option<String>,
    /// Drawn over the cover (Replay's ranks).
    pub rank_badge: Option<El>,
    pub on_play: Option<Action>,
    pub on_menu: Option<MenuAction>,
    pub play_label: Option<String>,
}

impl MediaCard {
    pub fn new(key: impl Into<String>, title: impl Into<String>) -> MediaCard {
        MediaCard {
            key: key.into(),
            to: None,
            cover: None,
            art_label: None,
            title: title.into(),
            subtitle: None,
            rank_badge: None,
            on_play: None,
            on_menu: None,
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
    pub fn art_label(mut self, label: impl Into<String>) -> Self {
        self.art_label = Some(label.into());
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
    pub fn on_menu(mut self, f: impl Fn(&mut App, PointerPress) + 'static) -> Self {
        self.on_menu = Some(Rc::new(f));
        self
    }

    /// The tile; size its width from the grid or shelf it sits in.
    pub fn build(self, app: &App, t: &Theme) -> El {
        let (_, _, title_fs) = card_metrics(t);
        let label = self.art_label.clone().unwrap_or_else(|| self.title.clone());
        let mut art = el().w_full().child(square_art(t, &app.images, self.cover.as_deref(), &label, t.radius_lg()));
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
            card = card.role("link").label(self.title.clone()).on_press(move |app: &mut App| app.navigate_to(&href));
        }
        if let Some(menu) = self.on_menu {
            card = card.on_secondary_press(move |app: &mut App, at, _| menu(app, at));
        }
        card
    }
}

/// `MediaCardPlaceholders`: stand-ins for a loading row of cards, the same
/// box as a real one.
pub fn media_card_placeholders(t: &Theme, key: &str, count: usize) -> Vec<El> {
    let (pad, gap, title_fs) = card_metrics(t);
    (0..count)
        .map(|n| {
            // `.skeleton-text`: a 0.75em bar centred on the line.
            let bar = |fs: f32, frac: f32| {
                el().w_full().h(fs * 1.45).items_center().child(el().w_frac(frac).h(fs * 0.75).radius(t.radius_sm()).fill(t.c.muted))
            };
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
    let vis = if p.visibility == Visibility::Collaborative { "Collaborative" } else { "Private" };
    match p.effective_role {
        Some(EffectiveRole::Editor) => format!("{vis} · editor"),
        Some(EffectiveRole::Viewer) => format!("{vis} · viewer"),
        _ => vis.to_string(),
    }
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
        .role("link")
        .label(p.name.clone())
        .child(art)
        .child(card_text(t, title, Some(&playlist_subtitle(p))))
        .on_press(move |app: &mut App| app.navigate_to(&href))
}

/// `TopArtistAction`: what a top artist's tile does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TopArtistAction {
    Open,
    Play,
}

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
