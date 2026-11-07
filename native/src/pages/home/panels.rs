//! `HomePanels.tsx`: Home's panels, one function per kind. Home loads what
//! they list (one request per source, however many panels draw on it) and
//! hands it over in a [`Ctx`]; each panel works out its natural height (its
//! usual rows), and, given its slot, how many items the room holds.

use std::rc::Rc;

use rune::{El, col, el, row, text};

use crate::api::stats::ReplayData;
use crate::api::{Playlist, TrackListItem};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::{Btn, font, icons as i, line, skeleton_line, skeleton_line_w, tnum, track_row};

use crate::ui::cards::{Action, MediaCard, media_card_height, media_card_placeholders, replay_rank};
use crate::ui::chart::activity_chart_sized;
use super::arrangement::{HomePanel, panel_title};
use super::board::{self, ArtistItem, Frame, Queue, TrackRow};
use super::fill::{FillUsual, count_in, usual_height};
use super::kinds::{DEFAULT_PERIOD, PanelKind, period_sub};
use super::logic::{self, Period, locale_int, pluralize_locale};
use super::{Model, Source, State};
use crate::format::clean_text;

/// A `MediaCard` as a board tile uses it.
struct Card {
    key: String,
    to: String,
    cover: Option<String>,
    title: String,
    subtitle: String,
    /// Replay's rank over the cover's corner (`.replay-rank`).
    rank: Option<usize>,
    on_play: Option<(String, Action)>,
}

/// The shared `MediaCard`, `width` wide (a tile of the board's grid).
fn media_card(app: &App, t: &Theme, c: Card, width: f32) -> El {
    let mut card = MediaCard::new(c.key, c.title).to(c.to).cover(c.cover).subtitle(c.subtitle);
    if let Some(n) = c.rank {
        card = card.rank_badge(replay_rank(t, n));
    }
    if let Some((label, play)) = c.on_play {
        card = card.on_play(label, move |app: &mut App| play(app));
    }
    el().w(width).child(card.build(app, t))
}

/// `MediaCardPlaceholders`, each `width` wide.
fn placeholders(t: &Theme, key: &str, count: usize, width: f32) -> Vec<El> {
    media_card_placeholders(t, key, count).into_iter().map(|c| el().w(width).child(c)).collect()
}

/// How much each panel usually holds; more is behind its "view all".
pub const ON_REPEAT_ROWS: usize = 8;
pub const LIST_ROWS: usize = 5;
pub const PLAYLIST_ROWS: usize = 4;
pub const GENRE_ROWS: usize = 5;

/// What the panels read (`PanelContext`), all borrowed: a frame copies none
/// of Home's lists.
pub struct Ctx<'a> {
    pub state: &'a State,
    /// The user's playlists; None until loaded.
    pub playlists: Option<&'a [Playlist]>,
    /// The board as the model worked it out: whether it has settled, the
    /// panels that show their source's load state, Albums' list, Jump back
    /// in's track (None while recently played loads).
    pub m: &'a Model,
    /// The window is 760 px or narrower (`responsive.css`).
    pub narrow_window: bool,
    /// The favourites store's rows ([`super::favorites`]).
    pub favorites: Source<'a, [TrackListItem]>,
    /// Build the panels' views; without, a panel whose room decides what it
    /// loads stops once it knows (Home's effects after a reply).
    pub views: bool,
}

impl Ctx<'_> {
    /// Show placeholders: nothing to list yet, and no error to show instead.
    pub fn pending(&self, count: usize, loading: bool, error: Option<&str>) -> bool {
        count == 0 && error.is_none() && (!self.m.settled || loading)
    }
    pub fn owns(&self, id: &str) -> bool {
        self.m.owners.contains(id)
    }
    fn failure(&self, panel: &HomePanel) -> Option<String> {
        self.state.failure.as_ref().filter(|(id, _)| *id == panel.id).map(|(_, m)| m.clone())
    }
}

/// A panel laid out: its natural height, and its view once given a height.
pub struct Out {
    pub natural: f32,
    pub view: Option<El>,
    /// How many items its room asks for, for a paged panel (`useWant`).
    pub want: Option<usize>,
}

/// A fill area's grid (`useBoardFill`'s measure).
struct Fill {
    usual: FillUsual,
    columns: usize,
    row: f32,
    gap: f32,
    margins: f32,
    /// Items it would list: the source's, or as many placeholders as asked.
    available: usize,
}

impl Fill {
    fn min(&self) -> f32 {
        let usual = self.usual.of(self.columns);
        usual_height(self.usual, self.columns, usual.min(self.available), self.row, self.gap, self.margins)
    }
    fn count(&self, room: f32) -> usize {
        count_in(self.usual, room, self.columns, self.row, self.gap, self.margins, self.available)
    }
}

/// The view for a panel `h` tall (or its natural height alone, without `h`).
pub fn panel(app: &App, t: &Theme, ctx: &Ctx, p: &HomePanel, w: f32, h: Option<f32>) -> Out {
    match p.kind {
        PanelKind::Resume => super::hero::resume(app, t, ctx, p, w, h),
        PanelKind::Repeat => repeat(app, t, ctx, p, w, h),
        PanelKind::Artists => artists(app, t, ctx, p, w, h),
        PanelKind::TopAlbums => top_albums(app, t, ctx, p, w, h),
        PanelKind::Stats => stats(t, ctx, p, w, h),
        PanelKind::Genres => genres(t, ctx, p, w, h),
        PanelKind::Activity => activity(t, ctx, p, w, h),
        PanelKind::Recent | PanelKind::Favorites | PanelKind::Added | PanelKind::Playlist => track_rows(app, t, ctx, p, w, h),
        PanelKind::Albums => albums(app, t, ctx, p, w, h),
        PanelKind::Playlists => playlists(app, t, ctx, p, w, h),
    }
}

/// `replayLink`.
pub fn replay_link(period: Option<Period>) -> String {
    format!("/replay?period={}", period.unwrap_or(DEFAULT_PERIOD).key())
}

/// A source's load state as its panel's status: an error and Retry (while
/// loading it's for screen readers only), and the height it takes.
fn status(t: &Theme, p: &HomePanel, title: &str, error: Option<&str>, loading: bool, retry: Action, content: f32) -> (Option<El>, f32) {
    match (error, loading) {
        (Some(e), false) => (Some(board::status(t, &p.id, title, e, retry)), board::status_height(e, content)),
        _ => (None, 0.0),
    }
}

/// [`status`] in the panel that shows its source's load state (the first
/// panel on it with something to show).
fn status_of<T: ?Sized>(ctx: &Ctx, t: &Theme, p: &HomePanel, source: Source<T>, retry: Action, content: f32) -> (Option<El>, f32) {
    if !ctx.owns(&p.id) {
        return (None, 0.0);
    }
    status(t, p, &panel_title(p, ctx.playlists), source.error, source.loading, retry, content)
}

/// A panel's frame, and the height it takes beside its body: the head, the
/// load state (`status`), a failed Play's alert in a panel that plays
/// (`alerts`), and a footer `footer_h` tall.
#[allow(clippy::too_many_arguments)]
fn frame_of(
    ctx: &Ctx,
    p: &HomePanel,
    content: f32,
    sub: impl Into<String>,
    to: impl Into<String>,
    status: (Option<El>, f32),
    alerts: bool,
    footer_h: f32,
) -> (Frame, f32) {
    let title = panel_title(p, ctx.playlists);
    let alert = if alerts { ctx.failure(p) } else { None };
    let fixed = board::frame_height(&title, content) + status.1 + alert.as_deref().map_or(0.0, |a| board::alert_height(a, content)) + footer_h;
    let mut frame = Frame::new(format!("panel-{}", p.id), sub, title, to);
    frame.status = status.0;
    frame.alert = alert;
    (frame, fixed)
}

/// [`frame_of`] for a panel on a Replay period: the period over the title,
/// Replay for "view all", the period's load state.
fn period_frame(ctx: &Ctx, t: &Theme, p: &HomePanel, content: f32, source: Source<ReplayData>, alerts: bool, footer_h: f32) -> (Frame, f32) {
    let period = p.period;
    let retry: Action = Rc::new(move |app: &mut App| super::sources::load_replay(app, period.unwrap_or(DEFAULT_PERIOD)));
    let status = status_of(ctx, t, p, source, retry, content);
    frame_of(ctx, p, content, period_sub(period), replay_link(period), status, alerts, footer_h)
}

/// Play on an album's card: its tracks fetched, the panel saying why when
/// they can't play.
fn play_album(panel: &str, name: &str, album_id: &str) -> Action {
    let (panel, name, album_id) = (panel.to_string(), name.to_string(), album_id.to_string());
    Rc::new(move |app: &mut App| {
        let album_id = album_id.clone();
        super::play_fetched(app, &panel, &name, move |c| crate::api::library::list_album_tracks(c, &album_id))
    })
}

/// Builds the frame around a fill body, or reports its natural height.
#[allow(clippy::too_many_arguments)]
fn finish(t: &Theme, frame: Frame, w: f32, h: Option<f32>, fixed: f32, min: f32, body: impl FnOnce(f32) -> El, want: Option<usize>) -> Out {
    let natural = fixed + min;
    let view = h.map(|h| frame.build(t, w, h, body((h - fixed).max(min))));
    Out { natural, view, want }
}

fn repeat(app: &App, t: &Theme, ctx: &Ctx, p: &HomePanel, w: f32, h: Option<f32>) -> Out {
    let content = board::content_width(w);
    let source = ctx.state.replay_of(p.period);
    let replay = source.data;
    let top: &[crate::api::stats::ReplayTrack] = replay.map(|r| r.top_tracks.as_slice()).unwrap_or(&[]);
    let empty = replay.is_some_and(|r| r.summary.total_plays == 0);
    let fill = Fill { usual: FillUsual::Count(ON_REPEAT_ROWS), columns: board::list_columns(content), row: board::ROW_H, gap: 0.0, margins: 0.0, available: top.len() };
    // `loading` needs the count, which needs the room; the footer shows
    // whenever there's a list or placeholders, so it's there either way
    // unless the period has nothing (then the panel is off the board).
    let pending_any = ctx.pending(if empty { 0 } else { top.len().min(ON_REPEAT_ROWS) }, source.loading, source.error);
    let has_footer = !top.is_empty() || pending_any;
    let placeholders = Fill { available: if pending_any { usize::MAX } else { fill.available }, ..fill };
    let (mut frame, fixed) = period_frame(ctx, t, p, content, source, false, if has_footer { board::FOOTER_H } else { 0.0 });
    let min = placeholders.min();
    let natural = fixed + min;
    let Some(h) = h else { return Out { natural, view: None, want: None } };
    let count = placeholders.count(h - fixed);
    // The rows shown are the queue (`usePlayFromList(play, onRepeat)`).
    let on_repeat: Vec<TrackListItem> = top.iter().take(count).map(|r| r.track.clone()).collect();
    let loading = ctx.pending(if empty { 0 } else { on_repeat.len() }, source.loading, source.error);
    let plays = logic::plays_by_id(top);
    let queue = Rc::new(on_repeat);
    if !queue.is_empty() || loading {
        let n = queue.len();
        let label = if n > 0 { format!("Play all {n}") } else { "Play all".to_string() };
        let all = queue.clone();
        frame.footer = Some(
            Btn::new(format!("{}-playall", p.id), label).disabled(n == 0).icon(&i::PLAY_FILLED).icon_size(16.0).build(t).on_press(
                move |app: &mut App| {
                    track_row::start_list(app, &all, false);
                },
            ),
        );
    }
    let body = if loading {
        board::board_list(&format!("{}-list", p.id), board::row_placeholders(t, &p.id, count, true, false), content)
    } else {
        let rows = queue
            .iter()
            .enumerate()
            .map(|(n, track)| {
                board::track_row(app, t, format!("{}-row-{n}", p.id), track, TrackRow {
                    ranked: true,
                    rank: n + 1,
                    bare: false,
                    current: false,
                    meta: locale_int(plays.get(&track.id).copied().unwrap_or(0)),
                    queue: Queue::Rows(queue.clone()),
                })
            })
            .collect();
        board::board_list(&format!("{}-list", p.id), rows, content)
    };
    Out { natural, view: Some(frame.build(t, w, h, col().w_full().child(body))), want: None }
}

fn artists(app: &App, t: &Theme, ctx: &Ctx, p: &HomePanel, w: f32, h: Option<f32>) -> Out {
    let content = board::content_width(w);
    let source = ctx.state.replay_of(p.period);
    let replay = source.data;
    let empty = replay.is_some_and(|r| r.summary.total_plays == 0);
    let list: &[crate::api::stats::ReplayArtist] = replay.map(|r| r.top_artists.as_slice()).unwrap_or(&[]);
    let top_tracks: &[crate::api::stats::ReplayTrack] = replay.map(|r| r.top_tracks.as_slice()).unwrap_or(&[]);
    let columns = board::artist_columns(content);
    let pending = ctx.pending(if empty { 0 } else { list.len() }, source.loading, source.error);
    let fill = Fill {
        usual: FillUsual::ARow,
        columns,
        row: board::ARTIST_H,
        gap: 4.0,
        margins: -4.0,
        available: if pending { usize::MAX } else if empty { 0 } else { list.len() },
    };
    let (frame, fixed) = period_frame(ctx, t, p, content, source, true, 0.0);
    let id = p.id.clone();
    let tile_w = board::tile_width(content, columns);
    finish(t, frame, w, h, fixed, fill.min(), |room| {
        let count = fill.count(room);
        let tiles = if pending {
            board::artist_placeholders(t, &format!("{id}-ph"), count, tile_w)
        } else {
            let shown = if empty { &[][..] } else { &list[..count.min(list.len())] };
            shown
                .iter()
                .map(|artist| {
                    let own: Vec<TrackListItem> =
                        logic::tracks_by_artist(artist, top_tracks).into_iter().map(|r| r.track.clone()).collect();
                    let action = logic::top_artist_action(artist, &own);
                    let (panel, name, tracks) = (id.clone(), artist.name.clone(), own.clone());
                    ArtistItem {
                        id: artist.id.clone(),
                        name: artist.name.clone(),
                        detail: pluralize_locale(artist.plays, "play"),
                        image: logic::artist_image_url(&own, 128),
                        action,
                        on_play: Rc::new(move |app: &mut App| {
                            let tracks = tracks.clone();
                            super::play_fetched(app, &panel, &name, move |_| Ok(tracks))
                        }),
                    }
                })
                .map(|a| {
                    let key = format!("{id}-artist-{}", a.id);
                    board::artist_tile(app, t, key, a, tile_w)
                })
                .collect()
        };
        board::tile_grid(&format!("{id}-artists"), tiles, content, columns)
    }, None)
}

fn covers_fill(t: &Theme, content: f32, available: usize) -> (Fill, f32) {
    let columns = board::cover_columns(content);
    let tile = board::tile_width(content, columns);
    (Fill { usual: FillUsual::ARow, columns, row: media_card_height(t, tile), gap: 4.0, margins: -4.0, available }, tile)
}

fn top_albums(app: &App, t: &Theme, ctx: &Ctx, p: &HomePanel, w: f32, h: Option<f32>) -> Out {
    let content = board::content_width(w);
    let source = ctx.state.replay_of(p.period);
    let albums: &[crate::api::stats::ReplayAlbum] =
        source.data.filter(|r| r.summary.total_plays > 0).map(|r| r.top_albums.as_slice()).unwrap_or(&[]);
    let pending = ctx.pending(albums.len(), source.loading, source.error);
    let (fill, tile) = covers_fill(t, content, if pending { usize::MAX } else { albums.len() });
    let (frame, fixed) = period_frame(ctx, t, p, content, source, true, 0.0);
    let id = p.id.clone();
    finish(t, frame, w, h, fixed, fill.min(), |room| {
        let count = fill.count(room);
        let mut tiles = if pending { placeholders(t, &format!("{id}-ph"), count, tile) } else { Vec::new() };
        for (n, album) in albums.iter().take(count).enumerate() {
            let target = logic::replay_album_target(album);
            let on_play: Option<(String, Action)> = (target.kind != crate::core::entity_target::EntityKind::Tidal)
                .then(|| (format!("Play {}", album.title), play_album(&id, &album.title, &target.id)));
            tiles.push(media_card(app, t, Card {
                key: format!("{id}-album-{}", album.id),
                to: target.album_href(),
                cover: Some(crate::api::media::album_cover_path(&album.id, Some(384), None)),
                title: clean_text(Some(&album.title)),
                subtitle: logic::replay_album_subtitle(album),
                rank: Some(n + 1),
                on_play,
            }, tile));
        }
        board::tile_grid(&format!("{id}-covers"), tiles, content, fill.columns)
    }, None)
}

/// `.board-stats`' rows: four figures in two columns, or one row of four
/// once the panel is 600 px wide.
fn stats_height(content: f32) -> f32 {
    let rows = if content >= 600.0 { 1.0 } else { 2.0 };
    8.0 + rows * 54.2 + (rows - 1.0) * 12.0
}

fn stats(t: &Theme, ctx: &Ctx, p: &HomePanel, w: f32, h: Option<f32>) -> Out {
    let content = board::content_width(w);
    let source = ctx.state.replay_of(p.period);
    let summary = source.data.map(|r| &r.summary);
    let loading = ctx.pending(summary.map_or(0, |s| s.total_plays as usize), source.loading, source.error);
    let headline = summary.and_then(|s| s.headline_artist.as_ref());
    let shows = summary.is_some_and(|s| s.total_plays > 0);
    let body_h = if loading {
        stats_height(content)
    } else if shows {
        stats_height(content) + if headline.is_some() { 12.0 + 18.85 } else { 0.0 }
    } else {
        0.0
    };
    let (frame, fixed) = period_frame(ctx, t, p, content, source, false, 0.0);
    let natural = fixed + body_h;
    let Some(h) = h else { return Out { natural, view: None, want: None } };
    let figures: Vec<(&str, String)> = match summary {
        Some(s) if !loading => vec![
            ("Plays", locale_int(s.total_plays)),
            ("Listening time", logic::format_listening_time(s.total_ms)),
            ("Tracks", locale_int(s.unique_tracks)),
            ("Artists", locale_int(s.unique_artists)),
        ],
        _ => ["Plays", "Listening time", "Tracks", "Artists"].into_iter().map(|l| (l, String::new())).collect(),
    };
    let columns = if content >= 600.0 { 4 } else { 2 };
    let cell_w = (content - 16.0 * (columns as f32 - 1.0)) / columns as f32;
    let mut body = col().w_full();
    if loading || shows {
        let mut grid = col().w_full().mt(8.0).gap(12.0).a11y_hidden();
        for chunk in figures.chunks(columns) {
            let mut r = row().w_full().gap(16.0);
            for (label, value) in chunk {
                let dd = if loading { stat_skeleton(t) } else { line(value.clone(), board::stat_value_style(), t.c.card_foreground) };
                r = r.child(
                    col().w(cell_w).min_w(0.0).gap(2.0)
                        .child(board::lh(text(*label).font(font(12.0, 400.0)).color(t.c.muted_foreground), 17.4))
                        .child(board::lh(dd, 34.8)),
                );
            }
            grid = grid.child(r);
        }
        body = body.child(grid);
        if !loading && let Some(a) = headline {
            body = body.child(board::lh(
                row().w_full().min_w(0.0)
                    .child(text("Most played: ").font(font(13.0, 400.0)).color(t.c.muted_foreground))
                    .child(line(clean_text(Some(&a.name)), font(13.0, 500.0), t.c.foreground)),
                18.85,
            ).mt(12.0));
        }
    }
    Out { natural, view: Some(frame.build(t, w, h, body)), want: None }
}

/// A figure still loading: a `4ch` skeleton bar on the 24 px line (four
/// zero advances of the tabular figures).
fn stat_skeleton(t: &Theme) -> El {
    skeleton_line_w(t, 24.0, 34.8, crate::ui::ch(4.0, board::stat_value_style()))
}

fn genres(t: &Theme, ctx: &Ctx, p: &HomePanel, w: f32, h: Option<f32>) -> Out {
    let content = board::content_width(w);
    let source = ctx.state.replay_of(p.period);
    let shares = source.data.filter(|r| r.summary.total_plays > 0).map(|r| logic::genre_shares(&r.top_genres)).unwrap_or_default();
    let pending = ctx.pending(shares.len(), source.loading, source.error);
    let columns = if content >= 600.0 { 2 } else { 1 };
    let fill = Fill {
        usual: FillUsual::Count(GENRE_ROWS),
        columns,
        row: if pending { 30.0 } else { 30.3 },
        gap: 12.0,
        margins: 8.0,
        available: if pending { usize::MAX } else { shares.len() },
    };
    let (frame, fixed) = period_frame(ctx, t, p, content, source, false, 0.0);
    finish(t, frame, w, h, fixed, fill.min(), |room| {
        let count = fill.count(room);
        let cell_w = (content - 24.0 * (columns as f32 - 1.0)) / columns as f32;
        let items: Vec<El> = if pending {
            (0..count).map(|_| el().w(cell_w).h(30.0).child(skeleton_line(t, 14.0, 20.3, 0.6))).collect()
        } else {
            shares
                .iter()
                .take(count)
                .map(|(g, share)| {
                    col().w(cell_w).gap(4.0)
                        .child(board::lh(
                            row().w_full().h(20.3).gap(12.0).items_center()
                                .child(line(clean_text(Some(&g.genre)), font(14.0, 400.0), t.c.card_foreground).grow(1.0))
                                .child(text(format!("{share:.0}%")).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground)),
                            20.3,
                        ))
                        .child(
                            el().w_full().h(6.0).radius(999.0).fill(t.c.muted).clip_rounded(999.0)
                                .child(el().w(cell_w * (*share as f32 / 100.0)).h(6.0).radius(999.0).fill(t.c.primary)),
                        )
                })
                .collect()
        };
        let mut list = col().w_full().mt(8.0).gap(12.0);
        let mut it = items.into_iter().peekable();
        while it.peek().is_some() {
            let mut r = row().w_full().gap(24.0).items_start();
            for _ in 0..columns {
                if let Some(item) = it.next() {
                    r = r.child(item);
                }
            }
            list = list.child(r);
        }
        list
    }, None)
}

fn activity(t: &Theme, ctx: &Ctx, p: &HomePanel, w: f32, h: Option<f32>) -> Out {
    let content = board::content_width(w);
    let source = ctx.state.replay_of(p.period);
    let replay = source.data;
    let loading = ctx.pending(replay.map_or(0, |r| r.summary.total_plays as usize), source.loading, source.error);
    let (frame, fixed) = period_frame(ctx, t, p, content, source, false, 0.0);
    let id = p.id.clone();
    finish(t, frame, w, h, fixed, 8.0 + 148.0, |room| {
        let chart_h = room - 8.0;
        let mut area = col().w_full().mt(8.0).h(chart_h);
        if !loading && let Some(r) = replay.filter(|r| r.summary.total_plays > 0) {
            // As Replay charts it: by day for a month, by month for longer.
            let range = logic::period_range(p.period.unwrap_or(DEFAULT_PERIOD));
            let (bucket, buckets) = match logic::replay_calendar(r, &range, crate::core::dates::now_ms()) {
                Some(cal) => logic::activity_series(&cal, range.bucket.unwrap_or(crate::api::stats::ReplayBucket::Month)),
                None => (r.bucket, r.activity.clone()),
            };
            area = area.child(activity_chart_sized(t, &format!("{id}-chart"), &buckets, bucket, chart_h));
        }
        area
    }, None)
}

/// A panel of track rows, each playing the list from there
/// (`TrackRowsPanel`: Recently played, Your favorites, Recently added, a
/// playlist's tracks).
fn track_rows(app: &App, t: &Theme, ctx: &Ctx, p: &HomePanel, w: f32, h: Option<f32>) -> Out {
    let content = board::content_width(w);
    let st = ctx.state;
    // Each list as the state holds it: rows play through it, and its menu
    // queues it, as it is when they're used.
    let (sub, to, source, paged, queue): (&str, String, Source<[TrackListItem]>, bool, Queue) = match p.kind {
        PanelKind::Recent => ("Picked up where you left off", "/recent".into(), Source::list(&st.recent), true, Queue::of(|a| Source::list(&a.pages.home.recent).rows())),
        PanelKind::Favorites => ("Hearts", "/favorites".into(), ctx.favorites, false, Queue::of(|a| super::favorites(a).rows())),
        PanelKind::Added => ("New in your library", "/library".into(), Source::list(&st.tracks), true, Queue::of(|a| Source::list(&a.pages.home.tracks).rows())),
        _ => {
            let id = p.playlist.clone().unwrap_or_default();
            (
                "Playlist",
                format!("/playlists/{}", urlencoding::encode(&id)),
                st.playlist_of(p.playlist.as_deref(), ctx.playlists).unwrap_or_else(Source::gone),
                false,
                Queue::of(move |a| a.pages.home.playlist_tracks.get(&id).map_or(&[], |r| Source::list(r).rows())),
            )
        }
    };
    let tracks = source.rows();
    let placeholders = ctx.pending(tracks.len(), source.loading, source.error);
    let fill = Fill {
        usual: FillUsual::Count(LIST_ROWS),
        columns: board::list_columns(content),
        row: board::ROW_H,
        gap: 0.0,
        margins: 0.0,
        available: if placeholders { usize::MAX } else { tracks.len() },
    };
    let retry: Action = match p.kind {
        PanelKind::Recent => Rc::new(|app: &mut App| super::sources::load_recent(app)),
        PanelKind::Favorites => Rc::new(|app: &mut App| super::sources::load_favorites(app)),
        PanelKind::Added => Rc::new(|app: &mut App| super::sources::load_tracks(app)),
        _ => {
            let id = p.playlist.clone().unwrap_or_default();
            Rc::new(move |app: &mut App| super::sources::load_playlist(app, &id))
        }
    };
    let status = status_of(ctx, t, p, source, retry, content);
    let has_footer = p.kind == PanelKind::Playlist && !tracks.is_empty();
    let (mut frame, fixed) = frame_of(ctx, p, content, sub, to, status, false, if has_footer { board::FOOTER_H } else { 0.0 });
    let natural = fixed + fill.min();
    let want = |count: usize| paged.then_some(count);
    let Some(h) = h else {
        return Out { natural, view: None, want: want(fill.count(fill.min())) };
    };
    let count = fill.count((h - fixed).max(fill.min()));
    if !ctx.views {
        return Out { natural, view: None, want: want(count) };
    }
    if has_footer {
        let all = queue.clone();
        frame.footer = Some(
            Btn::new(format!("{}-playall", p.id), format!("Play all {}", tracks.len())).icon(&i::PLAY_FILLED).icon_size(16.0).build(t)
                .on_press(move |app: &mut App| {
                    let list = all.read(app).to_vec();
                    track_row::start_list(app, &list, false);
                }),
        );
    }
    let body = if placeholders {
        board::row_placeholders(t, &p.id, count, false, false)
    } else {
        tracks
            .iter()
            .take(count)
            .enumerate()
            .map(|(n, track)| {
                board::track_row(app, t, format!("{}-row-{n}", p.id), track, TrackRow {
                    ranked: false,
                    rank: n + 1,
                    bare: false,
                    current: false,
                    meta: crate::format::fmt_duration_ms(track.duration_ms),
                    queue: queue.clone(),
                })
            })
            .collect()
    };
    let view = frame.build(t, w, h, col().w_full().child(board::board_list(&format!("{}-list", p.id), body, content)));
    Out { natural, view: Some(view), want: want(count) }
}

fn albums(app: &App, t: &Theme, ctx: &Ctx, p: &HomePanel, w: f32, h: Option<f32>) -> Out {
    let content = board::content_width(w);
    let source = Source::list(&ctx.state.tracks);
    let list = &ctx.m.albums;
    let pending = ctx.pending(list.len(), source.loading, source.error);
    let (fill, tile) = covers_fill(t, content, if pending { usize::MAX } else { list.len() });
    let status = status_of(ctx, t, p, source, Rc::new(|app: &mut App| super::sources::load_tracks(app)), content);
    let (frame, fixed) = frame_of(ctx, p, content, "Your library", "/library?view=albums", status, true, 0.0);
    let natural = fixed + fill.min();
    let Some(h) = h else { return Out { natural, view: None, want: Some(fill.count(fill.min())) } };
    let count = fill.count((h - fixed).max(fill.min()));
    if !ctx.views {
        return Out { natural, view: None, want: Some(count) };
    }
    let id = p.id.clone();
    let mut tiles = if pending { placeholders(t, &format!("{id}-ph"), count, tile) } else { Vec::new() };
    for a in list.iter().take(count) {
        tiles.push(media_card(app, t, Card {
            key: format!("{id}-album-{}", a.id),
            to: format!("/library?view=albums&album={}&by={}", urlencoding::encode(&a.id), urlencoding::encode(&a.artist)),
            cover: Some(crate::api::media::album_cover_path(&a.id, Some(384), None)),
            title: clean_text(Some(&a.title)),
            subtitle: clean_text(Some(&a.artist)),
            rank: None,
            on_play: Some((format!("Play {}", a.title), play_album(&id, &a.title, &a.id))),
        }, tile));
    }
    let body = board::tile_grid(&format!("{id}-covers"), tiles, content, fill.columns);
    Out { natural, view: Some(frame.build(t, w, h, col().w_full().child(body))), want: Some(count) }
}

fn playlists(app: &App, t: &Theme, ctx: &Ctx, p: &HomePanel, w: f32, h: Option<f32>) -> Out {
    let content = board::content_width(w);
    let source = Source::list(&app.playlists);
    let list: &[Playlist] = source.rows();
    let pending = ctx.pending(list.len(), source.loading, source.error);
    let fill = Fill {
        usual: FillUsual::Count(PLAYLIST_ROWS),
        columns: board::list_columns(content),
        row: board::ROW_H,
        gap: 0.0,
        margins: 0.0,
        available: if pending { usize::MAX } else { list.len() },
    };
    // Every Playlists panel shows the list's load state.
    let retry: Action = Rc::new(|app: &mut App| super::sources::load_playlists(app));
    let status = status(t, p, &panel_title(p, None), source.error, source.loading, retry, content);
    let (frame, fixed) = frame_of(ctx, p, content, "Curated", "/playlists", status, true, 0.0);
    let id = p.id.clone();
    finish(t, frame, w, h, fixed, fill.min(), |room| {
        let count = fill.count(room);
        let rows = if pending {
            board::row_placeholders(t, &id, count, false, false)
        } else {
            list.iter()
                .take(count)
                .map(|pl| {
                    let (panel, name, pid) = (id.clone(), pl.name.clone(), pl.id.clone());
                    let play: Action = Rc::new(move |app: &mut App| {
                        let pid = pid.clone();
                        super::play_fetched(app, &panel, &name, move |c| crate::api::playlists::list_playlist_tracks(c, &pid).map(|l| l.tracks.iter().map(|e| e.as_track()).collect::<Vec<_>>()))
                    });
                    board::playlist_row(app, t, format!("{id}-pl-{}", pl.id), pl, play)
                })
                .collect()
        };
        col().w_full().child(board::board_list(&format!("{id}-list"), rows, content))
    }, None)
}
