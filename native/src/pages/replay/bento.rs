//! `components/replay/ReplayBento.tsx` (`replay.css`): Replay as one panel
//! split by hairlines into tiles sized by importance: the most played track,
//! the period's figures, the rest of the top tracks, the activity chart,
//! genres, and the top artists and albums. Everything named here plays or
//! opens in one click.

use std::rc::Rc;

use rune::{Color, Cursor, Cx, El, Link, LinkPaint, PointerPress, Shadow, col, el, row, text};

use super::layout::{Areas, BentoTiles, bands, bento_areas, cells, column, span_width};
use crate::api::stats::{ReplayActivityBucket, ReplayBucket, ReplayData, ReplayTrack};
use crate::api::{TrackListItem, media};
use crate::app::App;
use crate::core::dates::{self, MONTHS_LONG, MONTHS_SHORT};
use crate::core::entity_target::{EntityKind, EntityTarget, replay_album_target, track_album_target};
use crate::core::replay::figures::{
    CalendarUnit, ReplayCalendar, TopArtistAction, activity_peak, activity_series, genre_shares, plays_per_unit,
    replay_album_subtitle, replay_track_artists, top_artist_action, top_artist_tracks,
};
use crate::core::replay::period::{ListeningTimeStyle, format_listening_time};
use crate::format::{display_text, fmt_duration_ms, group_thousands, js_round, pluralize_grouped, to_fixed};
use crate::overlays::track_menu::{self, MenuContext};
use crate::theme::Theme;
use crate::ui::blocks::animated_value;
use crate::ui::cards::{self, MediaCard};
use crate::ui::chart::{self, Bar, Bucket};
use crate::ui::shelf::shelf_pb;
use crate::ui::tooltip::TipExt;
use crate::ui::track_list::{Extra, TrackList};
use crate::ui::track_row;
use crate::ui::{Btn, BtnState, css_border, exact, font, ico, icons as i, iconbtn, line, motion, tnum, with_lh};

/// The day strip has a cell per day up to a month's worth; longer periods
/// get a bar.
const MAX_STRIP_CELLS: usize = 31;
/// Tracks the panel lists before "Show all": the most played and six more.
pub(super) const SHOWN_TRACKS: usize = 8;

// Line boxes: the body's 1.45 line height at each size.
pub(super) const LH12: f32 = 17.4;
pub(super) const LH14: f32 = 20.3;
/// `.bento-head`: a 14 px label and its 8 px margin.
pub(super) const HEAD_H: f32 = LH14 + 8.0;
/// `.bento-tile`'s padding.
pub(super) const PAD: f32 = 16.0;
/// `.bento-row`.
pub(super) const ROW_H: f32 = 48.0;
/// `.bento-foot`: 8 px over a small button.
pub(super) const FOOT_H: f32 = 8.0 + 28.0;
/// `.bento-act .activity-chart`.
pub(super) const CHART_H: f32 = 124.0;

/// Where the panel's container queries put it: four columns from 880 px,
/// the phone layout under 560.
#[derive(Clone, Copy, Debug)]
pub(super) struct Fit {
    /// `.replay-results`'s width.
    pub panel: f32,
    pub wide: bool,
    pub small: bool,
}

impl Fit {
    pub fn of(panel: f32) -> Fit {
        Fit { panel, wide: panel >= 880.0, small: panel < 560.0 }
    }
}

/// Text that a row centres (`align-items: center`): Rune rounds a text's
/// box up to whole pixels, so it goes down by half the rounding to sit
/// where Chromium centres the fractional box.
pub(super) fn centred(e: El, lh: f32) -> El {
    e.offset(0.0, (lh.ceil() - lh) / 2.0)
}

/// `.replay-enter > .bento-tile > *`: when a period's results land, each
/// tile's contents rise 8 px into place over 300 ms, a tile at a time, 40 ms
/// apart (`order`), all within 160 ms. The tiles stay put: moving one would
/// open a gap onto the hairlines behind it.
fn rise(e: El, order: usize) -> El {
    let enter = rune::Transition::offset(0.0, 8.0).combined(rune::Transition::opacity());
    // Leaving, they go at once: the next period's placeholder takes over.
    let t = rune::Transition::asymmetric(enter, rune::Transition::none());
    e.transition(t.springs(rune::SpringPair::new(rune::Spring::new(0.3, 0.0), rune::Spring::NONE)))
        .enter_delay(order.min(4) as f32 * 0.04)
}

/// `.bento-tile`.
pub(super) fn tile(t: &Theme, key: &str) -> El {
    col().key(key.to_string()).min_w(0.0).padding(PAD).fill(t.c.card).transition(rune::Transition::none())
}

/// `.bento-head`: the muted label and, on its baseline at the right, a note.
pub(super) fn head(_t: &Theme, label: El, note: Option<El>) -> El {
    let mut h = row().w_full().h(LH14).mb(8.0).items_start().justify_between().gap(12.0).child(label);
    if let Some(n) = note {
        // A 12 px line's baseline sits 2.16 px lower in its box than a 14 px
        // one's in theirs (Geist: ascent 1.005, descent 0.295).
        h = h.child(n.mt(LH14 / 2.0 + 0.355 * 14.0 - (LH12 / 2.0 + 0.355 * 12.0)));
    }
    h
}

/// `.bento-label` (an `h2` with no margin).
pub(super) fn label(t: &Theme, s: &str) -> El {
    exact(text(s.to_string()).font(font(14.0, 400.0)).color(t.c.muted_foreground), LH14)
}

/// `.bento-note`: 12 px, tabular, unwrapped.
fn note(t: &Theme, s: &str) -> El {
    exact(text(s.to_string()).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground), LH12)
}

/// `.stat-card-value`'s line box at the panel's size.
pub(super) fn value_lh(fit: Fit) -> f32 {
    if fit.small { 24.0 * 1.15 } else { 30.0 * 1.15 }
}

/// What a figure's tile holds under its value.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Sub {
    None,
    Text,
    /// The day strip (`.replay-days`).
    Strip,
    /// The share bar (`.replay-days-meter`).
    Meter,
}

/// A figure tile's content height (`.stat-card`).
pub(super) fn stat_need(fit: Fit, sub: Sub) -> f32 {
    let sub_h = match sub {
        Sub::None => 0.0,
        Sub::Text => 2.0 + LH12,
        Sub::Strip => 2.0 + 6.0 + 12.0,
        Sub::Meter => 2.0 + 8.0 + 8.0,
    };
    2.0 * PAD + LH14 + 8.0 + value_lh(fit) + sub_h
}

/// `.stat-card`: the label at the top, the value and its note at the bottom.
pub(super) fn stat_tile(t: &Theme, key: &str, label: El, value: El, sub: Option<El>, order: Option<usize>) -> El {
    let mut bottom = col().w_full().child(value);
    if let Some(s) = sub {
        bottom = bottom.child(col().w_full().mt(2.0).child(s));
    }
    let (label, bottom) = match order {
        Some(n) => (rise(label, n), rise(bottom, n)),
        None => (label, bottom),
    };
    tile(t, key).justify_between().gap(8.0).child(label).child(bottom)
}

/// `.stat-card-label`.
pub(super) fn stat_label(t: &Theme, s: &str) -> El {
    exact(line(s.to_string(), font(14.0, 400.0), t.c.muted_foreground), LH14)
}

/// `.stat-card-sub` as text.
fn stat_sub(t: &Theme, s: &str) -> El {
    exact(line(s.to_string(), tnum(font(12.0, 400.0)), t.c.muted_foreground), LH12)
}

/// `.stat-card-value`'s type.
fn value_style(fit: Fit) -> rune::TextStyle {
    let size = if fit.small { 24.0 } else { 30.0 };
    tnum(with_lh(font(size, 600.0), value_lh(fit)).tracking(-0.025 * size))
}

/// The value line, and `small` after it ("266 of 310"): the small text on
/// the value's baseline, a space of the value's type after it.
fn value_line(t: &Theme, fit: Fit, value: String, small: Option<String>) -> El {
    let style = value_style(fit);
    let lh = value_lh(fit);
    let mut v = el().w_full().h(lh).child(text(value.clone()).font(style).color(t.c.foreground));
    if let Some(s) = small {
        // `letter-spacing` follows every character of the value and the space.
        let plain = rune::TextStyle { tracking: 0.0, ..style };
        let x = rune::text::advance(&format!("{value} "), plain) + style.tracking * (value.chars().count() + 1) as f32;
        let small_lh = 14.0 * 1.15;
        let y = crate::ui::css_baseline(style.size, lh) - crate::ui::css_baseline(14.0, small_lh);
        v = v.child(
            text(s).font(tnum(with_lh(font(14.0, 400.0), small_lh))).color(t.c.muted_foreground).absolute(x, y),
        );
    }
    v
}

/// "1.4" plays a day: whole numbers from ten up, one decimal below.
pub(super) fn format_rate(n: f64) -> String {
    let fixed = to_fixed(n, if n >= 10.0 { 0 } else { 1 });
    let fixed = fixed.strip_suffix(".0").unwrap_or(&fixed).to_string();
    let (int, frac) = fixed.split_once('.').map_or((fixed.as_str(), None), |(a, b)| (a, Some(b)));
    let int = group_thousands(int.parse().unwrap_or(0));
    match frac {
        Some(f) => format!("{int}.{f}"),
        None => int,
    }
}

/// "45 min" rather than the phone's "45m": the desktop has room for it.
fn listening_time(ms: f64) -> String {
    format_listening_time(ms as i64, ListeningTimeStyle::Verbose)
}

/// `CHART_TITLE`.
pub(super) fn chart_title(bucket: ReplayBucket) -> &'static str {
    match bucket {
        ReplayBucket::Day => "Every day",
        ReplayBucket::Week => "Every week",
        ReplayBucket::Month => "Every month",
    }
}

/// `peakLabel`: the busiest bucket, short for the note and long for its
/// tooltip.
fn peak_label(start: &str, bucket: ReplayBucket, spans_years: bool) -> (String, String) {
    const WEEKDAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    let p = dates::utc_parts(dates::parse(start).unwrap_or(0));
    let short_day = format!("{} {}", MONTHS_SHORT[p.month as usize - 1], p.day);
    let long_day = format!("{}, {} {}, {}", WEEKDAYS[p.weekday as usize], MONTHS_LONG[p.month as usize - 1], p.day, p.year);
    let month_year = format!("{} {}", MONTHS_LONG[p.month as usize - 1], p.year);
    match bucket {
        ReplayBucket::Day => (short_day, long_day),
        ReplayBucket::Week => (format!("Week of {short_day}"), format!("Week of {long_day}")),
        ReplayBucket::Month => {
            (if spans_years { month_year.clone() } else { MONTHS_LONG[p.month as usize - 1].to_string() }, month_year)
        }
    }
}

/// A library album's page, or TIDAL's.
pub(super) fn album_href(target: &EntityTarget) -> String {
    let param = if target.kind == EntityKind::Tidal { "tidalAlbum" } else { "album" };
    format!("/library?view=albums&{param}={}", urlencoding::encode(&target.id))
}

/// The menu a Replay track opens: Play with the top tracks, Song info, and
/// Share where the track can be.
fn open_menu(app: &mut App, track: &TrackListItem, at: [f32; 2]) {
    let ctx = MenuContext {
        queue: track_row::playable(&app.pages.replay.queue),
        edit: false,
        move_to_album: false,
        info: true,
        share: track_row::can_share(track),
        selection: None,
    };
    track_menu::open(app, track.clone(), at, ctx);
}

/// `play(track, queue)`.
fn play(app: &mut App, track: &TrackListItem) {
    let queue = app.pages.replay.queue.clone();
    app.player.play(track, &queue, crate::player::local::PlayOptions::default());
}

fn queue_source(app: &App) -> &[TrackListItem] {
    &app.pages.replay.queue
}

/// A tile placed in the panel: its element, and the height its content
/// needs (read where it shares a band with a tile spanning rows).
pub(super) struct Tile {
    pub name: &'static str,
    pub el: El,
    pub need: f32,
}

/// The panel: `areas` laid out over `columns` equal columns of a
/// `width`-wide box, one band of rows under another, the 1 px gaps showing
/// the `--border` background as hairlines, inside a 1 px border.
pub(super) fn panel(t: &Theme, key: &str, areas: &Areas, columns: usize, width: f32, mut tiles: Vec<Tile>) -> El {
    let col_w = column(width - 2.0, columns);
    let all = cells(areas);
    let needs: Vec<(&'static str, f32)> = tiles.iter().map(|x| (x.name, x.need)).collect();
    let need = |name: &str| needs.iter().find(|x| x.0 == name).map_or(0.0, |x| x.1);
    let mut take = |name: &str| -> Tile {
        let at = tiles.iter().position(|x| x.name == name).expect("a tile for every area");
        tiles.remove(at)
    };
    // The panel's structure mounts whole (Rune would fade each new box in).
    let still = || rune::Transition::none();
    let mut body = col().w_full().gap(1.0).transition(still());
    for band in bands(areas) {
        let mut inside: Vec<_> = all.iter().filter(|c| c.r0 >= band.start && c.r1 <= band.end).copied().collect();
        inside.sort_by_key(|c| (c.r0, c.c0));
        let mut r = row().w_full().gap(1.0).items_stretch().transition(still());
        if band.len() == 1 {
            for c in &inside {
                r = r.child(take(c.name).el.w(span_width(col_w, c.c1 - c.c0)));
            }
            body = body.child(r);
            continue;
        }
        let tall: Vec<_> = inside.iter().filter(|c| c.r0 == band.start && c.r1 == band.end).copied().collect();
        let short: Vec<_> = inside.iter().filter(|c| !(c.r0 == band.start && c.r1 == band.end)).copied().collect();
        let rows: Vec<f32> = band
            .clone()
            .map(|row_at| short.iter().filter(|c| c.r0 == row_at).map(|c| need(c.name)).fold(0.0, f32::max))
            .collect();
        let tall_need = tall.iter().map(|c| need(c.name)).fold(0.0, f32::max);
        let heights = super::layout::band_rows(&rows, tall_need);
        let mut c = 0;
        while c < columns {
            if let Some(tc) = tall.iter().find(|x| x.c0 == c) {
                r = r.child(take(tc.name).el.w(span_width(col_w, tc.c1 - tc.c0)));
                c = tc.c1;
                continue;
            }
            let end = tall.iter().map(|x| x.c0).filter(|x| *x > c).min().unwrap_or(columns);
            let mut strip = col().w(span_width(col_w, end - c)).gap(1.0).transition(still());
            for (k, row_at) in band.clone().enumerate() {
                let mut line = row().w_full().gap(1.0).items_stretch().min_h(heights[k]).grow(1.0).transition(still());
                for sc in short.iter().filter(|x| x.r0 == row_at && x.c0 >= c && x.c1 <= end) {
                    line = line.child(take(sc.name).el.w(span_width(col_w, sc.c1 - sc.c0)));
                }
                strip = strip.child(line);
            }
            r = r.child(strip);
            c = end;
        }
        body = body.child(r);
    }
    let radius = t.radius_xl();
    css_border(el(), 1.0, t.c.border, radius)
        .key(key.to_string())
        // Swapped in and out at once, as the web swaps the loading bento,
        // the empty state and the results.
        .transition(rune::Transition::none())
        .w_full()
        .padding(1.0)
        .radius(radius)
        .fill(t.c.border)
        .child(body.clip_rounded(radius - 1.0))
}

/// `ReplayBento`: the period's tiles, for a period with plays.
#[allow(clippy::too_many_arguments)]
pub(super) fn view(
    app: &App,
    t: &Theme,
    cx: &mut Cx<App>,
    d: &ReplayData,
    calendar: Option<&ReplayCalendar>,
    chart_bucket: ReplayBucket,
    panel_w: f32,
) -> El {
    let s = &app.pages.replay;
    let fit = Fit::of(panel_w);
    let top = d.top_tracks.first();
    let others: Vec<&ReplayTrack> = d.top_tracks.iter().skip(1).take(SHOWN_TRACKS - 1).collect();
    // "Play top tracks" and "Generate playlist" go past the eight shown, so
    // the rest are one click away too, in the full table.
    let more = d.top_tracks.len() > SHOWN_TRACKS;
    let (series_bucket, series) = match calendar {
        Some(c) => activity_series(c, chart_bucket),
        None => (d.bucket, d.activity.clone()),
    };
    let genres: Vec<_> = genre_shares(&d.top_genres).into_iter().take(5).collect();
    let tiles = BentoTiles {
        feat: top.is_some(),
        list: !others.is_empty(),
        genre: !genres.is_empty(),
        art: !d.top_artists.is_empty(),
        alb: !d.top_albums.is_empty(),
    };
    let (wide, narrow) = bento_areas(tiles, s.all_tracks);
    let (areas, columns) = if fit.wide { (wide, 4) } else { (narrow, 2) };
    let col_w = column(panel_w - 2.0, columns);
    let all = cells(&areas);
    let width = |name: &str| all.iter().find(|c| c.name == name).map_or(0.0, |c| span_width(col_w, c.c1 - c.c0));
    let unit = if calendar.is_some_and(|c| c.unit == CalendarUnit::Month) { "month" } else { "day" };

    let mut out: Vec<Tile> = Vec::new();
    if let Some(top) = top {
        let (el, need) = featured(app, t, top, width("feat"), fit);
        out.push(Tile { name: "feat", el, need });
    }

    // The figures.
    let summary = &d.summary;
    let per_unit = plays_per_unit(summary.total_plays, calendar);
    let plays = animated_value(app, cx, "replay-plays-n", summary.total_plays as f64);
    out.push(Tile {
        name: "plays",
        el: stat_tile(
            t,
            "replay-plays",
            stat_label(t, "Plays"),
            value_line(t, fit, crate::ui::blocks::format_count(plays), None),
            per_unit.map(|r| stat_sub(t, &format!("{} a {unit} on average", format_rate(r)))),
            Some(1),
        ),
        need: stat_need(fit, if per_unit.is_some() { Sub::Text } else { Sub::None }),
    });
    let ms = animated_value(app, cx, "replay-time-n", summary.total_ms as f64);
    let minutes = (summary.total_ms >= 3_600_000).then(|| pluralize_grouped(js_round(summary.total_ms as f64 / 60_000.0) as u64, "minute"));
    out.push(Tile {
        name: "time",
        el: stat_tile(
            t,
            "replay-time",
            stat_label(t, "Listening time"),
            value_line(t, fit, listening_time(ms), None),
            minutes.as_deref().map(|m| stat_sub(t, m)),
            Some(1),
        ),
        need: stat_need(fit, if minutes.is_some() { Sub::Text } else { Sub::None }),
    });
    let tracks = animated_value(app, cx, "replay-tracks-n", summary.unique_tracks as f64);
    out.push(Tile {
        name: "tracks",
        el: stat_tile(
            t,
            "replay-tracks",
            stat_label(t, "Tracks"),
            value_line(t, fit, crate::ui::blocks::format_count(tracks), None),
            Some(stat_sub(t, &format!("by {}", pluralize_grouped(summary.unique_artists, "artist")))),
            Some(2),
        ),
        need: stat_need(fit, Sub::Text),
    });
    // By month only when the server's cap cut a long history short: it
    // can't say which days had plays then.
    let days_label = days_label(calendar);
    let (days_value, days_sub, sub_kind) = match calendar {
        Some(c) => {
            let n = animated_value(app, cx, "replay-days-n", c.with_plays as f64);
            let kind = if c.plays.len() > MAX_STRIP_CELLS { Sub::Meter } else { Sub::Strip };
            (
                value_line(t, fit, crate::ui::blocks::format_count(n), Some(format!("of {}", group_thousands(c.plays.len() as u64)))),
                Some(with_plays(t, c)),
                kind,
            )
        }
        None => (value_line(t, fit, "—".into(), None), None, Sub::None),
    };
    let mut days = stat_tile(t, "replay-days", stat_label(t, days_label), days_value, days_sub, Some(2));
    if let Some(c) = calendar {
        let tip = format!("{} of {} had plays", group_thousands(c.with_plays as u64), pluralize_grouped(c.plays.len() as u64, unit));
        days = days.tip("replay-days", &tip);
    }
    out.push(Tile { name: "days", el: days, need: stat_need(fit, sub_kind) });

    if tiles.list {
        let w = width("list");
        let (el, need) = if s.all_tracks {
            (full_list(app, t, d, more), 0.0)
        } else {
            repeat_list(app, t, &others, top.map_or(0, |x| x.plays), more, d.top_tracks.len(), w, fit)
        };
        out.push(Tile { name: "list", el, need });
    }

    // Activity.
    let title = chart_title(series_bucket);
    let peak = activity_peak(&series).map(|p| {
        let spans_years = series.first().zip(series.last()).is_some_and(|(a, b)| a.bucket_start.get(..4) != b.bucket_start.get(..4));
        let (short, long) = peak_label(&p.bucket_start, series_bucket, spans_years);
        let plays = pluralize_grouped(p.plays, "play");
        note(t, &format!("Peak {short} · {plays}")).tip("replay-peak", &format!("Busiest: {long} · {plays}"))
    });
    let chart = activity(t, &series, series_bucket);
    let act_need = 2.0 * PAD + HEAD_H + if series.is_empty() { 2.0 * 29.0 + LH14 } else { CHART_H };
    out.push(Tile { name: "act", el: tile(t, "replay-act").child(rise(head(t, label(t, title), peak), 3)).child(rise(chart, 3)), need: act_need });

    if tiles.genre {
        let mut list = col().w_full().gap(8.0);
        for (n, (g, share)) in genres.iter().enumerate() {
            list = list.child(genre_row(
                t,
                &format!("replay-genre-{n}"),
                exact(line(display_text(Some(&g.genre), ""), font(14.0, 400.0), t.c.foreground), LH14),
                Some(*share),
                Some(format!("{} · {}%", group_thousands(g.plays), to_fixed(*share, 0))),
            ));
        }
        let n = genres.len() as f32;
        out.push(Tile {
            name: "genre",
            el: tile(t, "replay-genre").child(rise(head(t, label(t, "Genres"), None), 4)).child(rise(list, 4)),
            need: 2.0 * PAD + HEAD_H + n * LH14 + (n - 1.0) * 8.0,
        });
    }

    if tiles.art {
        let artist_tracks = top_artist_tracks(&d.top_artists, &d.top_tracks);
        let cards: Vec<El> = d
            .top_artists
            .iter()
            .enumerate()
            .map(|(n, a)| {
                let own: Vec<TrackListItem> =
                    artist_tracks.get(&a.id).map(|v| v.iter().map(|t| t.track.clone()).collect()).unwrap_or_default();
                artist_card(app, t, n, &a.id, &display_text(Some(&a.name), ""), a.plays, a.has_page, own)
            })
            .collect();
        out.push(Tile { name: "art", el: cards_tile(app, t, "art", "Top artists", !tiles.alb, cards, width("art"), fit), need: 0.0 });
    }
    if tiles.alb {
        let cards: Vec<El> = d
            .top_albums
            .iter()
            .enumerate()
            .map(|(n, a)| {
                MediaCard::new(format!("replay-alb-{n}"), display_text(Some(&a.title), ""))
                    .to(album_href(&replay_album_target(a)))
                    .cover(Some(media::album_cover_path(&a.id, Some(384), None)))
                    .subtitle(replay_album_subtitle(a.artist.as_deref(), a.plays))
                    .rank_badge(rank_badge(t, n + 1))
                    .build(app, t)
            })
            .collect();
        out.push(Tile { name: "alb", el: cards_tile(app, t, "alb", "Top albums", !tiles.art, cards, width("alb"), fit), need: 0.0 });
    }
    // Keyed by period: a new period's tiles mount afresh and rise in.
    panel(t, &format!("replay-bento-{}", crate::core::replay::period::period_key(s.period)), &areas, columns, panel_w, out)
}

/// The days tile's label: by month only when the server's cap cut a long
/// history short.
pub(super) fn days_label(calendar: Option<&ReplayCalendar>) -> &'static str {
    if calendar.is_some_and(|c| c.unit == CalendarUnit::Month) { "Months with plays" } else { "Days with plays" }
}

/// `WithPlays`: a cell per day (or month), filled when it had plays, up to
/// a month's worth; a bar filled to their share for longer periods.
fn with_plays(t: &Theme, c: &ReplayCalendar) -> El {
    let total = c.plays.len();
    if total > MAX_STRIP_CELLS {
        return el()
            .w_full()
            .h(8.0)
            .mt(8.0)
            .radius(999.0)
            .fill(t.c.muted)
            .clip_rounded(999.0)
            .child(el().w_frac(c.with_plays as f32 / total as f32).h_full().radius(999.0).fill(t.c.primary));
    }
    let mut strip = row().w_full().h(12.0).mt(6.0).gap(2.0);
    for plays in &c.plays {
        let cell = el().grow(1.0).max_w(12.0).h_full().radius(2.0);
        strip = strip.child(if *plays > 0 { cell.fill(t.c.primary).opacity(0.85) } else { cell.border(1.0, t.c.input) });
    }
    strip
}

/// `-webkit-line-clamp`: `s` wrapped at `width` (`overflow-wrap: anywhere`)
/// and cut after `max` lines as Chromium cuts it: the last line keeps its
/// whole words and "…" follows them. Returns the text and its line count.
fn clamp_lines(s: &str, style: rune::TextStyle, width: f32, max: usize) -> (String, f32) {
    let options = rune::text::RichLayoutOptions::new().wrap_anywhere();
    let lines = |s: &str| (rune::text::measure_with(s, &[], style, Some(width), options).1 / style.line_height).round();
    let all = lines(s);
    if all <= max as f32 {
        return (s.to_string(), all.max(1.0));
    }
    let words: Vec<&str> = s.split(' ').collect();
    let mut keep = 1;
    while keep < words.len() && lines(&words[..keep + 1].join(" ")) <= max as f32 {
        keep += 1;
    }
    (format!("{}…", words[..keep].join(" ")), max as f32)
}

/// `FeaturedTrack`: the most played track, its cover, credits, plays and
/// actions. Returns the tile and the height its content needs.
fn featured(app: &App, t: &Theme, track: &ReplayTrack, width: f32, fit: Fit) -> (El, f32) {
    let tr = &track.track;
    let (pad, gap, art) = if fit.small { (16.0, 16.0, 112.0) } else { (20.0, 20.0, 208.0) };
    let (title_size, title_lh) = if fit.small { (20.0, 24.0) } else { (24.0, 28.8) };
    let body_w = (width - 2.0 * pad - art - gap).max(0.0);
    let title = display_text(Some(&tr.title), "");
    let title_style = with_lh(font(title_size, 600.0), title_lh).tracking(-0.025 * title_size);
    let (shown, lines) = clamp_lines(&title, title_style, body_w, 2);
    let body_h = LH14 + 6.0 + lines * title_lh + 2.0 + LH14 + 12.0 + LH14 + 16.0 + 40.0;
    let need = 2.0 * pad + art.max(body_h);

    let album = track_album_target(tr);
    let mut cover = el()
        .key("replay-feat-cover")
        .size(art, art)
        .child(crate::ui::cover_art(t, &app.images, Some(&track_row::cover_url(tr, 512)), &tr.title, art, art, t.radius_lg()));
    if let Some(a) = &album {
        let href = album_href(a);
        cover = cover.cursor(Cursor::Pointer).on_press(move |app: &mut App| app.navigate_to(&href));
    }

    // Artists, each linked when they have a page, then the album.
    let artists = replay_track_artists(tr.artist.as_deref(), track.primary_artists.as_deref());
    let mut sub = String::new();
    let mut links: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    if artists.is_empty() {
        sub.push_str("Unknown artist");
    }
    for (n, a) in artists.iter().enumerate() {
        if n > 0 {
            sub.push_str(", ");
        }
        let start = sub.len();
        sub.push_str(&display_text(Some(&a.name), ""));
        if let Some(id) = &a.artist_id {
            links.push((start..sub.len(), cards::artist_href(id)));
        }
    }
    if let Some(album_title) = tr.album_title.as_deref().filter(|s| !s.is_empty()) {
        sub.push_str(" · ");
        let start = sub.len();
        sub.push_str(&display_text(Some(album_title), ""));
        if let Some(a) = &album {
            links.push((start..sub.len(), album_href(a)));
        }
    }
    let sub_tip: Vec<String> = [Some(tr.artist.as_deref().filter(|s| !s.is_empty()).unwrap_or("Unknown artist")), tr.album_title.as_deref()]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .map(|s| display_text(Some(s), ""))
        .collect();
    let mut sub_el = text(sub).font(font(14.0, 400.0)).color(t.c.muted_foreground).truncate();
    for (range, href) in links {
        let paint = LinkPaint::new().color(t.c.foreground).underline(t.c.foreground);
        sub_el = sub_el.link(Link::new(range, href).hover(paint));
    }
    let sub_el = sub_el.on_link(|app: &mut App, href: &str, _tx: &mut rune::Tx| app.navigate_to(href));

    // Plays, and the time they took, estimated from the track's length.
    let plays = pluralize_grouped(track.plays, "play");
    let mut n = row().h(LH14).child(text(plays.clone()).font(tnum(font(14.0, 500.0))).color(t.c.foreground));
    if tr.duration_ms > 0 {
        let time = listening_time((track.plays * tr.duration_ms) as f64);
        n = n.child(
            text(format!(" · about {time}"))
                .font(tnum(font(14.0, 400.0)))
                .color(t.c.muted_foreground)
                .tip("replay-feat-time", &format!("Estimated: {plays} of a {} track", fmt_duration_ms(tr.duration_ms))),
        );
    }

    let fav = app.pages.favorites_has(&tr.id);
    let pop = app.widgets.lists.pops.get(&tr.id).copied().unwrap_or(0);
    let mut heart = ico(if fav { &i::HEART_FILLED } else { &i::HEART }, 14.0, t.c.foreground);
    if fav && pop > 0 {
        static POP: [rune_motion::Beat; 3] =
            [rune_motion::Beat::new(0.0), rune_motion::Beat::new(0.096).scale(1.25), rune_motion::Beat::new(0.24)];
        heart = heart.key(format!("replay-feat-heart-pop{pop}")).sequence(rune_motion::Sequence::new(&POP));
    }
    let fav_label = if fav { "Remove from favorites" } else { "Add to favorites" };
    let id = tr.id.clone();
    let heart_btn = el()
        .key("replay-feat-fav")
        .size(32.0, 32.0)
        .radius(t.radius_lg())
        .center()
        .role("button")
        .label(fav_label)
        .checked(fav)
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(t.c.ghost_hover)
        .press_scale(0.95)
        .child(heart)
        .on_press(move |app: &mut App| track_row::toggle_favorite(app, &id));
    let heart_btn = if fav { heart_btn.fill(t.c.muted) } else { heart_btn };
    let (t1, t2) = (tr.clone(), tr.clone());
    let more = iconbtn(t, "replay-feat-more", &i::ELLIPSIS, 16.0, BtnState::default())
        .label("More actions")
        .on_layout_tx(|app: &mut App, r: [f32; 4], tx: &mut rune::Tx| {
            app.pages.replay.more_at.set([r[0], r[1] + r[3] + 4.0]);
            tx.live_only();
        })
        .on_press(move |app: &mut App| {
            let at = app.pages.replay.more_at.get();
            open_menu(app, &t1, at);
        });
    let t3 = tr.clone();
    let play_btn = el()
        .key("replay-feat-play")
        .size(40.0, 40.0)
        .radius(999.0)
        .fill(t.c.primary)
        .center()
        .role("button")
        .label(format!("Play {title}"))
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(crate::ui::hover_overlay(t.c.primary, crate::theme::color_mix(t.c.primary, 0.8, Color::TRANSPARENT)))
        .hover_motion(motion::ease(120.0), motion::ease(120.0))
        .press_scale(0.97)
        .child(ico(&i::PLAY_FILLED, 20.0, t.c.primary_foreground))
        .on_press(move |app: &mut App| play(app, &t3));
    let acts = row().h(40.0).mt(16.0).gap(8.0).items_center().child(play_btn).child(heart_btn.tip("replay-feat-fav", fav_label)).child(more);

    let body = col()
        .grow(1.0)
        .min_w(0.0)
        .self_stretch()
        .justify_end()
        .child(label(t, "Most played track"))
        .child(
            el().w_full().h(lines * title_lh).mt(6.0).child(
                text(shown)
                    .font(title_style)
                    .color(t.c.foreground)
                    .wrap_anywhere()
                    .max_lines(2)
                    .w_full()
                    .tip("replay-feat-title", &title),
            ),
        )
        .child(exact(sub_el, LH14).mt(2.0).tip("replay-feat-sub", &sub_tip.join(" · ")))
        .child(exact(n, LH14).mt(12.0))
        .child(acts);
    let mut tile = row()
        .key("replay-feat")
        .transition(rune::Transition::none())
        .min_w(0.0)
        .padding(pad)
        .gap(gap)
        .fill(t.c.card)
        .role("article")
        .label("Most played track")
        .child(rise(cover, 0))
        .child(rise(body, 0))
        .on_secondary_press(move |app: &mut App, at: PointerPress, _tx: &mut rune::Tx| open_menu(app, &t2, [at.x, at.y]));
    tile = if fit.small { tile.items_start() } else { tile.items_center() };
    (tile, need)
}

/// The rows of "Also on repeat" (tracks #2 to #8), or of their placeholder.
#[allow(clippy::too_many_arguments)]
fn repeat_list(
    app: &App,
    t: &Theme,
    others: &[&ReplayTrack],
    max: u64,
    more: bool,
    total: usize,
    width: f32,
    fit: Fit,
) -> (El, f32) {
    let row_w = width - 2.0 * PAD + 16.0;
    let mut rows = col().w_full();
    for (n, tr) in others.iter().enumerate() {
        rows = rows.child(repeat_row(app, t, tr, n + 2, max, row_w, fit));
    }
    let head = head(t, label(t, "Also on repeat"), Some(note(t, "Plays")));
    let mut tile = tile(t, "replay-list").role("region").label("Also on repeat").child(rise(head, 3)).child(rise(rows, 3));
    if more {
        tile = tile.child(rise(foot(t, false, total), 3));
    }
    let need = 2.0 * PAD + HEAD_H + others.len() as f32 * ROW_H + if more { FOOT_H } else { 0.0 };
    (tile, need)
}

/// "Show all 12" / "Show fewer".
fn foot(t: &Theme, all: bool, total: usize) -> El {
    let label = if all { "Show fewer".to_string() } else { format!("Show all {total}") };
    let b = Btn::new("replay-show-all", label)
        .ghost()
        .small()
        .icon(if all { &i::CHEVRON_UP } else { &i::CHEVRON_DOWN })
        .icon_size(16.0)
        .build(t)
        .checked(all)
        .on_press(|app: &mut App| app.pages.replay.all_tracks = !app.pages.replay.all_tracks);
    row().w_full().mt(8.0).child(b.ml(-8.0))
}

/// The top tracks' whole table, with a Plays column.
fn full_list(app: &App, t: &Theme, d: &ReplayData, more: bool) -> El {
    let list = TrackList::new("replay-top", queue_source)
        .extra(Extra { header: "Plays", width: 64.0, align_end: true, render: plays_cell })
        .build(app, t);
    let mut tile = tile(t, "replay-list").role("region").label("Top tracks").child(rise(head(t, label(t, "Top tracks"), None), 3)).child(rise(list, 3));
    if more {
        tile = tile.child(rise(foot(t, true, d.top_tracks.len()), 3));
    }
    tile
}

/// The Plays column's cell: the track's plays this period.
fn plays_cell(app: &App, t: &Theme, tr: &TrackListItem) -> El {
    let plays = app.pages.replay.data().and_then(|d| d.top_tracks.iter().find(|x| x.track.id == tr.id)).map_or(0, |x| x.plays);
    let lit = app.player.current().is_some_and(|c| c.id == tr.id)
        || app.widgets.lists.selection("replay-top").is_some_and(|s| s.ids.contains(&tr.id));
    crate::ui::text_end(group_thousands(plays), tnum(font(12.0, 400.0)), if lit { t.c.foreground } else { t.c.muted_foreground })
}

/// `.play-cell` in a `.bento-rank`: the rank, turning into a play button
/// while the row is hovered. The cell is 18 px with one 24 px grid track,
/// so both centre 3 px right of and below its middle.
fn rank_cell(t: &Theme, key: &str, rank: usize, play_button: El) -> El {
    let track = || el().absolute(0.0, 0.0).size(24.0, 24.0).center();
    let number = text(rank.to_string()).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground);
    el().key(key.to_string())
        .size(18.0, 18.0)
        .child(track().child(centred(number, LH12).group_opacity(1.0, 0.0)))
        .child(track().child(play_button.group_opacity(0.0, 1.0)))
}

/// `RepeatRow`: one of tracks #2 to #8, playing on click, its plays drawn
/// against #1's.
fn repeat_row(app: &App, t: &Theme, track: &ReplayTrack, rank: usize, max: u64, width: f32, fit: Fit) -> El {
    let tr = &track.track;
    let key = format!("replay-row-{rank}");
    let title = display_text(Some(&tr.title), "");
    let t1 = tr.clone();
    let play_button = track_row::idx_play(t, &format!("{key}-play"), &format!("Play {title}"))
        .on_press(move |app: &mut App| play(app, &t1));
    let words = col()
        .grow(1.0)
        .min_w(0.0)
        .child(exact(line(title, font(14.0, 500.0), t.c.foreground), LH14))
        .child(exact(line(display_text(tr.artist.as_deref(), "Unknown artist"), font(12.0, 400.0), t.c.muted_foreground), LH12));
    let mut r = row()
        .key(key.clone())
        .w(width)
        .ml(-8.0)
        .h(ROW_H)
        .px(8.0)
        .gap(12.0)
        .items_center()
        .radius(t.radius_lg())
        .cursor(Cursor::Pointer)
        .hover(t.c.ghost_hover)
        .hover_motion(motion::ease(120.0), motion::ease(120.0))
        .child(el().w(24.0).h(18.0).pl(3.0).child(rank_cell(t, &format!("{key}-rank"), rank, play_button)))
        .child(crate::ui::cover_art(t, &app.images, Some(&track_row::cover_url(tr, 64)), &tr.title, 32.0, 32.0, t.radius_md()))
        .child(words);
    // The bars would leave the titles a few letters on a phone; the counts stay.
    if !fit.small {
        let share = if max > 0 { track.plays as f32 / max as f32 } else { 0.0 };
        r = r.child(
            el().w(72.0)
                .h(6.0)
                .radius(999.0)
                .fill(t.c.muted)
                .clip_rounded(999.0)
                .a11y_hidden()
                .child(el().w_frac(share).h_full().radius(999.0).fill(t.c.primary)),
        );
    }
    r = r.child(
        el().w(32.0).h(LH12).child(
            row().w_full().justify_end().child(crate::ui::text_end(group_thousands(track.plays), tnum(font(12.0, 400.0)), t.c.muted_foreground)),
        ),
    );
    let (t2, t3) = (tr.clone(), tr.clone());
    r.on_press(move |app: &mut App| play(app, &t2))
        .on_secondary_press(move |app: &mut App, at: PointerPress, _tx: &mut rune::Tx| open_menu(app, &t3, [at.x, at.y]))
}

/// The activity chart, by the series' own bucket.
fn activity(t: &Theme, series: &[ReplayActivityBucket], bucket: ReplayBucket) -> El {
    let bars: Vec<Bar> = series.iter().map(|b| Bar { start: b.bucket_start.clone(), plays: b.plays }).collect();
    let bucket = match bucket {
        ReplayBucket::Day => Bucket::Day,
        ReplayBucket::Week => Bucket::Week,
        ReplayBucket::Month => Bucket::Month,
    };
    chart::activity_chart_h(t, "replay-chart", &bars, bucket, CHART_H)
}

/// `.genre-row` in the bento: the label in a 112 px column, the share's
/// bar, and the count (`share` and `count` are `None` while loading).
pub(super) fn genre_row(t: &Theme, key: &str, label: El, share: Option<f64>, count: Option<String>) -> El {
    let mut bar = el().grow(1.0).min_w(0.0).h(8.0).radius(999.0).fill(t.c.muted).clip_rounded(999.0);
    if let Some(s) = share {
        bar = bar.child(el().w_frac((s / 100.0) as f32).h_full().radius(999.0).fill(t.c.primary));
    }
    let r = row().key(key.to_string()).w_full().h(LH14).gap(12.0).items_center().child(el().w(112.0).min_w(0.0).child(label)).child(bar);
    r.child(match count {
        Some(c) => {
            // An `auto` column: exactly the count's advance wide.
            let style = tnum(font(12.0, 400.0));
            el().w(rune::text::advance(&c, style)).child(centred(text(c).font(style).color(t.c.muted_foreground), LH12))
        }
        // The count's column, empty: its gap stays.
        None => el().w(0.0),
    })
}

/// `.replay-rank`: a card's place, over its cover's corner.
pub(super) fn rank_badge(t: &Theme, rank: usize) -> El {
    el().absolute(6.0, 6.0)
        .min_w(20.0)
        .h(20.0)
        .px(6.0)
        .radius(999.0)
        .fill(t.c.background)
        .center()
        .child(centred(text(rank.to_string()).font(tnum(font(12.0, 500.0))).color(t.c.foreground), LH12))
}

/// A top artist's card: their top track's cover, opening their page or
/// playing them (`TopArtistName`, `TopArtistGlyph`).
#[allow(clippy::too_many_arguments)]
fn artist_card(app: &App, t: &Theme, n: usize, id: &str, name: &str, plays: u64, has_page: Option<bool>, own: Vec<TrackListItem>) -> El {
    let key = format!("replay-art-{n}");
    let action = top_artist_action(has_page, &own);
    let url = own.first().map(|tr| track_row::cover_url(tr, 384));
    let mut art = el().w_full().child(cards::square_art(t, &app.images, url.as_deref(), name, t.radius_lg())).child(rank_badge(t, n + 1));
    if let Some(act) = action {
        let a = t.c.shadow_md_alpha;
        let glyph = el()
            .size(32.0, 32.0)
            .radius(999.0)
            .fill(t.c.primary)
            .center()
            .box_shadow(Shadow { x: 0.0, y: 4.0, blur: 6.0, spread: -1.0, color: Color::BLACK.alpha(a), inset: false })
            .box_shadow(Shadow { x: 0.0, y: 2.0, blur: 4.0, spread: -2.0, color: Color::BLACK.alpha(a), inset: false })
            .group_opacity(0.0, 1.0)
            .a11y_hidden()
            .child(ico(if act == TopArtistAction::Open { &i::ARROW_RIGHT } else { &i::PLAY_FILLED }, 16.0, t.c.primary_foreground));
        art = art.child(el().pin(None, None, Some(8.0), Some(8.0)).child(glyph));
    }
    let (_, _, title_fs) = cards::card_metrics(t);
    let words = cards::card_text(t, line(name.to_string(), font(title_fs, 500.0), t.c.foreground), Some(&pluralize_grouped(plays, "play")));
    let card = match action {
        Some(_) => cards::card_box(t, &key),
        None => {
            let (pad, gap, _) = cards::card_metrics(t);
            col().key(key.clone()).w_full().min_w(0.0).padding(pad).gap(gap).radius(t.radius_xl())
        }
    }
    .child(art)
    .child(words);
    let ui_action = action.map(|a| match a {
        TopArtistAction::Open => cards::TopArtistAction::Open,
        TopArtistAction::Play => cards::TopArtistAction::Play,
    });
    // As on Home: the library has nothing by them, so their top tracks are
    // what there is to play.
    let on_play: cards::Action = Rc::new(move |app: &mut App| {
        track_row::start_list(app, &own, false);
    });
    cards::top_artist_press(card, ui_action, id, name, on_play)
}

/// `CardsTile`: Home's scrolling shelf, four covers to the tile (eight when
/// the other cover tile is missing and this one spans the panel; two and a
/// bit on a phone).
#[allow(clippy::too_many_arguments)]
pub(super) fn cards_tile(app: &App, t: &Theme, area: &str, label_text: &str, alone: bool, cards: Vec<El>, width: f32, fit: Fit) -> El {
    // `.bento-minis`: the cards' own 8 px padding lines their covers up with
    // the tile's edge.
    let minis = width - 2.0 * PAD + 16.0;
    let gap = t.gap();
    let col_w = if fit.small {
        (minis - 2.0 * gap) / 2.3
    } else if alone && fit.wide {
        (minis - 7.0 * gap) / 8.0
    } else {
        (minis - 3.0 * gap) / 4.0
    };
    let key = format!("replay-{area}");
    tile(t, &key)
        .role("region")
        .label(label_text)
        .child(rise(head(t, label(t, label_text), None), 4))
        .child(rise(el().w(minis).ml(-8.0).mb(-8.0).child(shelf_pb(app, t, &format!("{key}-shelf"), label_text, cards, col_w, 0.0)), 4))
}
