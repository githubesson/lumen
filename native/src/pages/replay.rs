//! `Replay.tsx` (`replay.css`), at `/replay`: a period's listening, picked
//! with pills kept in the URL (`?period=last-30`), as one panel of tiles
//! (`replay/bento.rs`), with Play, Generate playlist and Share image.
//!
//! The answers live in [`State::cache`] under the keys Home's period panels
//! use for the same windows (`lib/replayData.ts`), so either page warms the
//! other.

mod bento;
mod layout;
mod placeholder;
#[cfg(test)]
mod tests;

use std::cell::Cell;

use rune::{Color, Cursor, Cx, El, col, el, row, text};

use crate::api::stats::{ReplayData, generate_replay_playlist, get_replay_image};
use crate::api::{TrackListItem, error_message};
use crate::app::App;
use crate::core::dates::{self, DAY_MS, MONTHS_SHORT};
use crate::core::replay::data::{ReplayCache, fetch_replay};
use crate::core::replay::figures::{
    CalendarUnit, ReplayCalendar, ReplayQueries, replay_calendar, replay_day_span, replay_image_filename, replay_image_request,
    replay_playlist_request, replay_queries,
};
use crate::core::replay::period::{
    Period, build_period_options, canonical_period_key, current_year, parse_period_key, period_key, period_label, period_title,
};
use crate::route::Location;
use crate::shell::Bp;
use crate::theme::Theme;
use crate::ui::blocks::play_list_button;
use crate::ui::kit::error_banner;
use crate::ui::{Btn, exact, font, icons as i, tnum, with_lh};

/// What the page keeps between visits.
pub struct State {
    /// The answers by period (the web's resource cache), and the years with
    /// plays the last one listed: the year pills, there on arrival.
    pub cache: ReplayCache,
    /// The period on screen (the URL's, made canonical).
    period: Period,
    /// How it's asked for, as of [`State::day`]: rolling periods move at
    /// midnight, and the request with them.
    request: Option<ReplayQueries>,
    /// The local day the request was made on (`useLocalDay`).
    day: i64,
    error: Option<String>,
    creating: bool,
    create_error: Option<String>,
    downloading: bool,
    image_error: Option<String>,
    /// "Show all": the bento's full table of top tracks (its `allTracks`,
    /// which a new period or visit resets).
    all_tracks: bool,
    /// The period's top tracks as list rows: what every play here queues.
    pub queue: Vec<TrackListItem>,
    /// Bumped by each request: answers to older ones are dropped (the web's
    /// abort).
    serial: u64,
    /// The history entry the page was last entered at: a new one is a new
    /// visit (the component remounting).
    visit: Option<(usize, usize, Option<String>)>,
    /// The results' height when they last had data: the loading bento keeps
    /// at least that, so the page doesn't shrink under it.
    last_h: Cell<f32>,
    /// Where "More actions" opens the track menu (its button's bottom-left).
    more_at: Cell<[f32; 2]>,
    /// A thread is watching for midnight.
    timer: bool,
}

impl Default for State {
    fn default() -> Self {
        State {
            cache: ReplayCache::default(),
            period: Period::ThisYear,
            request: None,
            day: 0,
            error: None,
            creating: false,
            create_error: None,
            downloading: false,
            image_error: None,
            all_tracks: false,
            queue: Vec::new(),
            serial: 0,
            visit: None,
            last_h: Cell::new(0.0),
            more_at: Cell::new([0.0; 2]),
            timer: false,
        }
    }
}

impl State {
    /// The period on screen's answer, by day or by month, if one came (here
    /// or on Home): still that period's own numbers, never another's.
    pub fn data(&self) -> Option<&ReplayData> {
        self.request.as_ref().and_then(|r| self.cache.read(r))
    }
}

/// The local calendar day of `ms`, as days since the epoch.
fn local_day(ms: i64) -> i64 {
    (ms + dates::local_offset_ms(ms)).div_euclid(DAY_MS)
}

/// The `?period=` value for `period`: none for this year, the default.
fn param_for(period: Period) -> Option<String> {
    (period != Period::ThisYear).then(|| period_key(period))
}

/// Runs on each navigation to the page: settle the URL's period on its one
/// spelling, then ask for it.
pub fn enter(app: &mut App, loc: &Location) {
    let now = dates::now_ms();
    let param = loc.get("period");
    let key = canonical_period_key(param, app.pages.replay.cache.years(), current_year(now));
    // A value that isn't a period, names this year, or a year with no plays
    // (once the years are known) opens this year, and the URL says so.
    if param != key.as_deref() {
        app.navigate_replace(loc.with("period", key.as_deref()));
        return;
    }
    let period = parse_period_key(key.as_deref()).unwrap_or(Period::ThisYear);
    let h = &app.history;
    let visit = (h.index, h.entries.len(), h.index.checked_sub(1).map(|p| h.entries[p].href()));
    let s = &mut app.pages.replay;
    let fresh = s.visit.as_ref() != Some(&visit);
    if fresh {
        s.create_error = None;
        s.image_error = None;
        s.last_h.set(0.0);
    }
    if fresh || s.period != period {
        s.all_tracks = false;
    }
    s.visit = Some(visit);
    s.period = period;
    s.request = Some(replay_queries(period, now));
    s.day = local_day(now);
    sync_queue(app);
    load(app);
    watch_midnight(app);
}

/// The queue for the answer on screen.
fn sync_queue(app: &mut App) {
    let s = &mut app.pages.replay;
    let queue = s.data().map(|d| d.top_tracks.iter().map(|t| t.track.clone()).collect()).unwrap_or_default();
    s.queue = queue;
}

/// `fetchReplay` for the period on screen: by day, again by month when an
/// all-time series came back cut short. A newer request drops this one's
/// answer.
fn load(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let s = &mut app.pages.replay;
    let Some(request) = s.request.clone() else { return };
    s.serial += 1;
    s.error = None;
    let serial = s.serial;
    let monthly_known = s.cache.has_monthly(&request);
    app.net.run(
        move || {
            let answer = fetch_replay(&client, &request, monthly_known);
            (request, answer)
        },
        move |app, (request, answer)| {
            if app.pages.replay.serial != serial {
                return;
            }
            match answer {
                Ok((query, data)) => {
                    app.pages.replay.cache.store(&request, &query, data);
                    sync_queue(app);
                    // The years with plays are known now: a year without any
                    // has no pill, so the URL can't keep it.
                    if app.location().is("/replay") {
                        let loc = app.location().clone();
                        let years = app.pages.replay.cache.years();
                        if canonical_period_key(loc.get("period"), years, current_year(dates::now_ms())).as_deref()
                            != loc.get("period")
                        {
                            enter(app, &loc);
                        }
                    }
                }
                Err(e) => app.pages.replay.error = Some(error_message(&e, "Failed to load Replay.")),
            }
        },
    );
}

/// Rolling periods move at midnight: a page left open past it asks for the
/// new day's window. Checked every half minute against the wall clock, so a
/// laptop waking from sleep catches up too.
fn watch_midnight(app: &mut App) {
    if app.pages.replay.timer || app.net.is_sync() {
        return;
    }
    app.pages.replay.timer = true;
    let day = app.pages.replay.day;
    let sender = app.net.sender();
    let spawned = std::thread::Builder::new().name("replay-midnight".into()).spawn(move || {
        while local_day(dates::now_ms()) == day {
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        sender.send(|app: &mut App| {
            app.pages.replay.timer = false;
            if app.location().is("/replay") {
                let loc = app.location().clone();
                enter(app, &loc);
            }
        });
    });
    if spawned.is_err() {
        app.pages.replay.timer = false;
    }
}

/// A pill: the period goes in the URL, replacing the entry (`setPeriod`).
fn set_period(app: &mut App, period: Period) {
    let loc = app.location().with("period", param_for(period).as_deref());
    app.navigate_replace(loc);
}

/// `onGeneratePlaylist`: the period's top tracks saved as a playlist, then
/// opened.
fn generate_playlist(app: &mut App) {
    let s = &mut app.pages.replay;
    let (Some(client), Some(request)) = (app.client.clone(), s.request.clone()) else { return };
    if s.creating || s.data().is_none_or(|d| d.summary.total_plays == 0) {
        return;
    }
    s.creating = true;
    s.create_error = None;
    let body = replay_playlist_request(s.period, &request.range, dates::now_ms());
    app.net.run(
        move || generate_replay_playlist(&client, body.from.as_deref(), body.to.as_deref(), &body.name, Some(body.limit)),
        |app, result| {
            app.pages.replay.creating = false;
            match result {
                Ok(playlist) => {
                    app.load_playlists();
                    app.navigate_to(&format!("/playlists/{}", playlist.id));
                }
                Err(e) => app.pages.replay.create_error = Some(error_message(&e, "Failed to create playlist.")),
            }
        },
    );
}

/// `onDownloadImage`: the server renders the period's share card; it lands
/// in the downloads folder, as the browser saves it.
fn share_image(app: &mut App) {
    let s = &mut app.pages.replay;
    let (Some(client), Some(request)) = (app.client.clone(), s.request.clone()) else { return };
    if s.downloading || s.data().is_none_or(|d| d.summary.total_plays == 0) {
        return;
    }
    s.downloading = true;
    s.image_error = None;
    let params = replay_image_request(s.period, &request.range, dates::now_ms());
    let name = replay_image_filename(s.period);
    app.net.run(
        move || {
            let bytes = get_replay_image(&client, params.from.as_deref(), params.to.as_deref(), Some(&params.title))?;
            crate::core::downloads::save_to_downloads(&name, &bytes).map(|_| ()).map_err(|e| crate::api::ApiError::transport(e.to_string()))
        },
        |app, result| {
            app.pages.replay.downloading = false;
            if let Err(e) = result {
                app.pages.replay.image_error = Some(error_message(&e, "Failed to create the share image."));
            }
        },
    );
}

/// en-US `Intl.DateTimeFormat#formatRange` as Chromium's ICU writes it
/// (plain spaces round the dash; Node's newer ICU uses thin ones): "Jan 1 – Nov 6, 2026",
/// "Nov 1 – 6, 2026", "Dec 30, 2025 – Jan 5, 2026"; by month "Mar 2013 –
/// Oct 2026", "Jan – Nov 2026". Dates are UTC midnights.
pub fn span_label(first: i64, last: i64, unit: CalendarUnit) -> String {
    const DASH: &str = " \u{2013} ";
    let (a, b) = (dates::utc_parts(first), dates::utc_parts(last));
    let (ma, mb) = (MONTHS_SHORT[a.month as usize - 1], MONTHS_SHORT[b.month as usize - 1]);
    match unit {
        CalendarUnit::Month => {
            if a.year != b.year {
                format!("{ma} {}{DASH}{mb} {}", a.year, b.year)
            } else if a.month != b.month {
                format!("{ma}{DASH}{mb} {}", b.year)
            } else {
                format!("{ma} {}", a.year)
            }
        }
        CalendarUnit::Day => {
            if a.year != b.year {
                format!("{ma} {}, {}{DASH}{mb} {}, {}", a.day, a.year, b.day, b.year)
            } else if a.month != b.month {
                format!("{ma} {}{DASH}{mb} {}, {}", a.day, b.day, b.year)
            } else if a.day != b.day {
                format!("{ma} {}{DASH}{}, {}", a.day, b.day, b.year)
            } else {
                format!("{ma} {}, {}", a.day, a.year)
            }
        }
    }
}

/// The days (or months) the period covers so far, once known: every period
/// but all time knows before its answer.
fn range_label(calendar: Option<&ReplayCalendar>, request: &ReplayQueries, now: i64) -> Option<String> {
    match calendar {
        Some(c) => Some(span_label(c.first, c.last, c.unit)),
        None => replay_day_span(&request.range, None, now).map(|s| span_label(s.first, s.last, CalendarUnit::Day)),
    }
}

/// `.view.replay`'s inner width: `.replay-results`, which the bento's
/// container queries read. Measured once laid out; until then, worked out
/// from the window the way the shell divides it.
fn panel_width(app: &App, t: &Theme, cx: &mut Cx<App>, window_w: f32) -> f32 {
    if let Some([w, _]) = cx.layout_size("replay-results") {
        return w;
    }
    // Less `.view`'s padding.
    crate::shell::content_estimate(app, t, window_w) - 2.0 * t.pad()
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let s = &app.pages.replay;
    let Some(request) = s.request.as_ref() else { return super::fallback(app, t) };
    let now = dates::now_ms();
    let data = s.data();
    let [window_w, _] = crate::shell::window_size(cx);
    let panel = panel_width(app, t, cx, window_w);
    let calendar = data.and_then(|d| replay_calendar(&d.activity, d.bucket, &request.range, now));
    let no_tracks = data.is_none() || s.queue.is_empty();

    let head = head(t, s, now, no_tracks, Bp::of(window_w) == Bp::Narrow);
    let mut under = row().w_full().flex_wrap().items_center().gaps(8.0, 12.0).child(pills(app, t));
    if let Some(label) = range_label(calendar.as_ref(), request, now) {
        under = under.child(exact(text(label).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground), 17.4));
    }
    let mut page = col().key("replay").w_full().padding(t.pad()).gap(16.0).child(head).child(under);
    for e in [&s.error, &s.create_error, &s.image_error].into_iter().flatten() {
        page = page.child(error_banner(t, e));
    }

    // No answer for this period and no error means its request is in flight.
    let loading = data.is_none() && s.error.is_none();
    let chart_bucket = request.range.bucket.unwrap_or(crate::api::stats::ReplayBucket::Month);
    let mut results = el().key("replay-results").w_full();
    if loading {
        // All time may come back by month: until it says, the days tile
        // names nothing.
        let unit_known = request.monthly.is_none();
        results = results.min_h(s.last_h.get()).child(placeholder::view(t, chart_bucket, unit_known, panel));
    } else if let Some(d) = data {
        if let Some([_, h]) = cx.layout_size("replay-results") {
            s.last_h.set(h);
        }
        results = if d.summary.total_plays == 0 {
            results.child(empty(t))
        } else {
            results.child(bento::view(app, t, cx, d, calendar.as_ref(), chart_bucket, panel))
        };
    }
    page.child(results)
}

/// `.replay-head`: the kind and title, and the actions, which take the
/// row's width under 760 px.
fn head(t: &Theme, s: &State, now: i64, no_tracks: bool, narrow: bool) -> El {
    let title = col()
        .min_w(0.0)
        .shrink()
        .child(exact(text("Replay").font(font(12.0, 500.0)).color(t.c.muted_foreground), 17.4))
        .child(
            text(period_title(s.period, now))
                .font(with_lh(font(30.0, 600.0), 33.0).tracking(-0.75))
                .color(t.c.foreground)
                .wrap_anywhere()
                .mt(4.0),
        );
    let fit = |b: El| if narrow { b.grow(1.0).min_w(120.0) } else { b };
    let play = play_list_button(t, "replay-play", "Play top tracks", |a| &a.pages.replay.queue, no_tracks);
    let generate = Btn::new("replay-generate", if s.creating { "Creating…" } else { "Generate playlist" })
        .icon(&i::LIST_MUSIC)
        .icon_size(16.0)
        .disabled(no_tracks || s.creating)
        .build(t)
        .on_press(generate_playlist);
    let share = Btn::new("replay-share", if s.downloading { "Rendering…" } else { "Share image" })
        .icon(&i::DOWNLOAD)
        .icon_size(16.0)
        .disabled(no_tracks || s.downloading)
        .build(t)
        .on_press(share_image);
    let mut actions = row().flex_wrap().items_center().gap(8.0).child(fit(play)).child(fit(generate)).child(fit(share));
    if narrow {
        actions = actions.w_full();
    }
    row().w_full().flex_wrap().items_end().justify_between().gaps(16.0, 24.0).child(title).child(actions)
}

/// `.period-pills`: the evergreen windows, past years with plays, all time.
fn pills(app: &App, t: &Theme) -> El {
    let s = &app.pages.replay;
    let years = s.cache.years().unwrap_or_default();
    let mut group = row().key("replay-pills").flex_wrap().padding(3.0).radius(t.radius_lg()).fill(t.c.muted).role("tablist").label("Replay period");
    for period in build_period_options(years, current_year(dates::now_ms())) {
        let active = period == s.period;
        let key = format!("replay-pill-{}", period_key(period));
        let r = t.radius_md();
        // Its label's fractional width: Rune rounds text boxes up, which
        // would add up along the row.
        let style = font(14.0, 500.0);
        let mut pill = el()
            .key(key)
            .w(rune::text::advance(&period_label(period), style) + 22.0)
            .h(26.0)
            .px(11.0)
            .items_center()
            .radius(r)
            .role("tab")
            .checked(active)
            .label(period_label(period))
            .cursor(Cursor::Pointer)
            .focusable(true)
            .on_press(move |app: &mut App| set_period(app, period));
        if active {
            pill = crate::ui::kit::segment_lit(t, pill, r);
        } else {
            pill = pill.hover(Color::TRANSPARENT).hover_motion(crate::ui::motion::ease(120.0), crate::ui::motion::ease(120.0));
        }
        let ink = if active { t.c.foreground } else { t.c.muted_foreground };
        pill = pill.child(exact(text(period_label(period)).font(style).color(ink).group_color(t.c.foreground), 20.3));
        group = group.child(pill);
    }
    group
}

/// `EmptyState` for a window without plays, its hint linking to the library.
fn empty(t: &Theme) -> El {
    let link = "Listen to some music";
    let rest = " and check back here.";
    let hint = text(format!("{link}{rest}"))
        .font(font(14.0, 400.0))
        .color(t.c.muted_foreground)
        .spans(vec![rune::text::Span { color: Some(t.c.foreground), underline: Some(t.c.foreground), ..rune::text::Span::new(0, link.len()) }])
        .link(rune::text::Link::new(0..link.len(), "/library"))
        .on_link(|app: &mut App, href: &str, _tx| app.navigate_to(href));
    col()
        .key("replay-empty")
        .transition(rune::Transition::none())
        .w_full()
        .px(24.0)
        .py(48.0)
        .gap(8.0)
        .items_center()
        .child(
            el().size(40.0, 40.0)
                .mb(4.0)
                .radius(t.radius_lg())
                .fill(t.c.muted)
                .center()
                .child(crate::ui::ico(&i::SPARKLES, 20.0, t.c.foreground)),
        )
        .child(exact(text("No plays in this window yet.").font(font(16.0, 500.0)).color(t.c.foreground), 23.2))
        .child(exact(hint, 20.3))
}

/// Scenes: Replay for a period, and its states (`app.rs`'s `SCENES`).
pub mod scenes {
    use super::*;

    /// The period's answer replaced with one without plays (an empty window).
    pub fn empty(app: &mut App) {
        let s = &mut app.pages.replay;
        let Some(request) = s.request.clone() else { return };
        let years = s.cache.years().map(<[i32]>::to_vec).unwrap_or_default();
        let data = ReplayData { available_years: years, ..ReplayData::default() };
        s.cache.store(&request, &request.daily, data);
        sync_queue(app);
    }

    /// The period's request still in flight: the placeholder bento.
    pub fn loading(app: &mut App) {
        let s = &mut app.pages.replay;
        s.cache = ReplayCache::default();
        s.serial += 1;
        sync_queue(app);
    }

    /// "Show all": the full table of top tracks.
    pub fn all_tracks(app: &mut App) {
        app.pages.replay.all_tracks = true;
    }
}
