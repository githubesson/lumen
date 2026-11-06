//! `EntityCards.tsx` (`AlbumCard`, `ArtistCard`), the artist page's
//! `ReleaseCard`, Library's `TracksGrid` card, and the `.grid-cards` grid
//! they sit in (`cards.css`, `library.css`).

use rune::{Color, Cursor, El, Shadow, col, el, row};

use crate::api::{Album, Artist, SearchAlbum, SearchArtist, TrackListItem, TrackSource, media};
use crate::app::App;
use crate::format::display_text;
use crate::theme::{Density, Theme};
use crate::ui::{self, font, ico, icons as i, line};

use super::logic::{self, ArtistRelease, EntityTarget};

/// `.grid-cards`: `repeat(auto-fill, minmax(168px, 1fr))` (200 airy, 148
/// dense) with the density's gap. The column count and width for `width`.
pub fn grid_columns(t: &Theme, width: f32) -> (usize, f32) {
    let min = match t.density {
        Density::Airy => 200.0,
        Density::Dense => 148.0,
        Density::Balanced => 168.0,
    };
    let gap = t.gap();
    let n = (((width + gap) / (min + gap)).floor() as usize).max(1);
    (n, ((width - gap * (n - 1) as f32) / n as f32).max(0.0))
}

/// The grid of `cards`, each built at the column width it's given.
pub fn grid(t: &Theme, key: &str, width: f32, cards: Vec<Box<dyn FnOnce(f32) -> El + '_>>) -> El {
    let (n, w) = grid_columns(t, width);
    let gap = t.gap();
    let mut out = col().key(key).w_full().gap(gap);
    let mut cards = cards.into_iter().peekable();
    while cards.peek().is_some() {
        let mut r = row().gap(gap).items_start();
        for c in cards.by_ref().take(n) {
            r = r.child(c(w));
        }
        out = out.child(r);
    }
    out
}

/// What a card shows.
pub struct Card<'a> {
    pub key: String,
    pub title: String,
    pub sub: String,
    pub cover: Option<String>,
    /// The cover's placeholder letter comes from this.
    pub letter_of: &'a str,
    /// An artist: a round picture and centred text.
    pub round: bool,
    pub badge: Option<&'static str>,
}

fn pad(t: &Theme) -> (f32, f32, f32) {
    // (padding, gap, title size)
    if t.density == Density::Dense { (6.0, 8.0, 12.0) } else { (8.0, 10.0, 14.0) }
}

/// `.card`: the cover, the title and a muted line under it.
pub fn card(app: &App, t: &Theme, c: Card, width: f32, play: Option<El>) -> El {
    let (p, gap, title_size) = pad(t);
    let art_w = (width - 2.0 * p).max(0.0);
    let radius = if c.round { 999.0 } else { t.radius_lg() };
    let mut art = el().size(art_w, art_w).child(ui::cover_art(t, &app.images, c.cover.as_deref(), c.letter_of, art_w, art_w, radius));
    if let Some(button) = play {
        art = art.child(button.absolute(art_w - 40.0, art_w - 40.0));
    }
    let (ts, ss) = (font(title_size, 500.0), font(12.0, 400.0));
    let mut title = crate::ui::exact(line(c.title, ts, t.c.foreground), ts.line_height).w_full();
    let mut sub = crate::ui::exact(line(c.sub, ss, t.c.muted_foreground), ss.line_height).w_full();
    if c.round {
        title = title.justify_center();
        sub = sub.justify_center();
    }
    let mut texts = col().w_full().min_w(0.0).child(title).child(sub);
    if let Some(b) = c.badge {
        texts = texts.child(row().mt(6.0).child(crate::ui::track_row::badge(t, b)));
    }
    col()
        .key(c.key)
        .w(width)
        .min_w(0.0)
        .padding(p)
        .gap(gap)
        .radius(t.radius_xl())
        .role("button")
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(t.c.ghost_hover)
        .hover_motion(ui::motion::ease(140.0), ui::motion::ease(140.0))
        .child(art)
        .child(texts)
}

/// `AlbumCard`: opens the album (its TIDAL page for a TIDAL result).
pub fn album_card(app: &App, t: &Theme, key: &str, a: &Album, source: Option<TrackSource>, extra: Option<&SearchAlbum>, width: f32) -> El {
    let cover = media::album_art(&a.id, Some(a.has_cover), extra.and_then(|s| s.cover_url.as_deref()), source, Some(384), None);
    let target = logic::search_entity_target(&a.id, source, extra.and_then(|s| s.source_id.as_deref()));
    card(
        app,
        t,
        Card {
            key: key.to_string(),
            title: display_text(Some(&a.title), ""),
            sub: logic::album_subtitle(a, source),
            cover,
            letter_of: &a.title,
            round: false,
            badge: None,
        },
        width,
        None,
    )
    .label(a.title.clone())
    .on_press(move |app: &mut App| super::open_album(app, target.clone()))
}

/// `AlbumCard` for a library album.
pub fn library_album_card(app: &App, t: &Theme, key: &str, a: &Album, width: f32) -> El {
    album_card(app, t, key, a, None, None, width)
}

/// `AlbumCard` for a search result.
pub fn search_album_card(app: &App, t: &Theme, key: &str, a: &SearchAlbum, width: f32) -> El {
    album_card(app, t, key, &a.album, Some(a.source), Some(a), width)
}

/// `ArtistCard`: opens the artist (with its name, for a TIDAL one).
pub fn artist_card(
    app: &App,
    t: &Theme,
    key: &str,
    a: &Artist,
    source: Option<TrackSource>,
    extra: Option<&SearchArtist>,
    width: f32,
) -> El {
    let cover = logic::artist_image_url(extra.and_then(|s| s.cover_url.as_deref()), &[], Some(384));
    let target = logic::search_entity_target(&a.id, source, extra.and_then(|s| s.source_id.as_deref()));
    let name = a.name.clone();
    card(
        app,
        t,
        Card {
            key: key.to_string(),
            title: display_text(Some(&a.name), ""),
            sub: logic::artist_subtitle(a.track_count, a.album_count, source),
            cover,
            letter_of: &a.name,
            round: true,
            badge: None,
        },
        width,
        None,
    )
    .label(a.name.clone())
    .on_press(move |app: &mut App| super::open_artist(app, target.clone(), Some(&name)))
}

/// `ReleaseCard` on an artist page.
pub fn release_card(app: &App, t: &Theme, key: &str, r: &ArtistRelease, width: f32) -> El {
    let cover = media::album_art(&r.id, r.has_cover, r.cover_url.as_deref(), r.source, Some(384), None);
    let target: EntityTarget = logic::release_target(r);
    card(
        app,
        t,
        Card {
            key: key.to_string(),
            title: display_text(Some(&r.title), ""),
            sub: logic::release_subtitle(r),
            cover,
            letter_of: &r.title,
            round: false,
            badge: None,
        },
        width,
        None,
    )
    .label(r.title.clone())
    .on_press(move |app: &mut App| super::open_album(app, target.clone()))
}

/// A `TracksGrid` card: the track's cover with a play button that shows on
/// hover, its title and artist, and a TIDAL badge.
pub fn track_card(app: &App, t: &Theme, key: &str, tr: &TrackListItem, queue: &[TrackListItem], width: f32) -> El {
    let cover = Some(media::track_cover(&tr.id, tr.album_id.as_deref(), tr.cover_url.as_deref(), Some(384)));
    let id = tr.id.clone();
    let q = queue.to_vec();
    let play = el()
        .key(format!("{key}-play"))
        .size(32.0, 32.0)
        .radius(999.0)
        .fill(t.c.primary)
        .center()
        .box_shadow(Shadow { x: 0.0, y: 4.0, blur: 6.0, spread: -1.0, color: Color::BLACK.alpha(t.c.shadow_md_alpha), inset: false })
        .box_shadow(Shadow { x: 0.0, y: 2.0, blur: 4.0, spread: -2.0, color: Color::BLACK.alpha(t.c.shadow_md_alpha), inset: false })
        .role("button")
        .label(format!("Play {}", tr.title))
        .cursor(Cursor::Pointer)
        .group_opacity(0.0, 1.0)
        .press_scale(0.95)
        .child(ico(&i::PLAY_FILLED, 16.0, t.c.primary_foreground))
        .on_press(move |app: &mut App| { if let Some(tr) = q.iter().find(|t| t.id == id).cloned() { crate::ui::track_row::play_from(app, &tr, &q) } });
    let letter = tr.album_title.as_deref().filter(|s| !s.is_empty()).unwrap_or(&tr.title);
    let menu_track = tr.clone();
    let menu_queue = queue.to_vec();
    card(
        app,
        t,
        Card {
            key: key.to_string(),
            title: display_text(Some(&tr.title), ""),
            sub: display_text(tr.artist.as_deref(), "Unknown artist"),
            cover,
            letter_of: letter,
            round: false,
            badge: (tr.source == Some(TrackSource::Tidal)).then_some("TIDAL"),
        },
        width,
        Some(play),
    )
    .focusable(false)
    .role("group")
    .on_secondary_press(move |app: &mut App, at: rune::PointerPress, _tx: &mut rune::Tx| {
        let ctx = crate::overlays::track_menu::MenuContext::bind(&menu_track, menu_queue.clone());
        crate::overlays::track_menu::open(app, menu_track.clone(), [at.x, at.y], ctx)
    })
}
