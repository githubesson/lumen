//! `replay-page.test.tsx` and `replay-period-link.test.tsx`: what the page
//! asks for and caches, which period the URL settles on, and what the tiles
//! open or play.

use std::cell::Cell;
use std::time::{Duration, Instant};

use super::*;
use crate::api::stats::{ReplayArtist, ReplayTrack, ReplayTrackArtist};
use crate::api::testing::{MockServer, Req, Res};
use crate::app::Session;
use crate::config::Config;
use crate::core::replay::figures::{TopArtistAction, replay_track_artists, top_artist_action, top_artist_tracks};
use crate::images::Images;
use crate::net::{LateWaker, Net};
use crate::route::History;

fn app(server: &MockServer, sync: bool) -> App {
    let waker = LateWaker::default();
    let app = App {
        config: Config::default(),
        tweaks: Default::default(),
        system_dark: Cell::new(true),
        waker: waker.clone(),
        net: Net::new(waker.clone()),
        images: Images::new(waker),
        client: Some(server.client()),
        session: Session::Loading,
        history: History::new(Location::parse("/")),
        playlists: None,
        pending_invites: 0,
        ui: Default::default(),
        player: Default::default(),
        pages: Default::default(),
        overlays: Default::default(),
        select: None,
        widgets: Default::default(),
    };
    app.net.set_sync(sync);
    app
}

fn go(app: &mut App, href: &str) {
    app.navigate(Location::parse(href));
    while Net::drain(app) {}
}

fn year() -> i32 {
    current_year(dates::now_ms())
}

fn track(id: &str, plays: u64) -> serde_json::Value {
    serde_json::json!({ "id": id, "title": format!("Track {id}"), "artist": "Kestrel Bay", "duration_ms": 200_000, "plays": plays })
}

/// A "this year" answer whose buckets hold `counted` of its 10 plays.
fn answer(bucket: &str, counted: u64) -> serde_json::Value {
    let day = if bucket == "day" { 5 } else { 1 };
    serde_json::json!({
        "summary": { "total_plays": 10, "total_ms": 2_000_000, "unique_tracks": 2, "unique_artists": 1 },
        "top_tracks": [track("a", 6), track("b", 4)],
        "top_artists": [{ "id": "ar-kestrel", "name": "Kestrel Bay", "plays": 10 }],
        "top_albums": [], "top_genres": [],
        "activity": [{ "bucket_start": format!("{}-01-{day:02}T00:00:00.000Z", year()), "plays": counted }],
        "bucket": bucket,
        "available_years": [year()],
    })
}

fn data(v: &serde_json::Value) -> ReplayData {
    serde_json::from_value(v.clone()).unwrap()
}

fn res(v: &serde_json::Value) -> Res {
    Res::json(&v.to_string())
}

/// A request's query parameter.
fn param(req: &Req, key: &str) -> Option<String> {
    let loc = Location::parse(&req.path);
    loc.get(key).map(str::to_string)
}

fn calendar(app: &App) -> Option<ReplayCalendar> {
    let s = &app.pages.replay;
    let d = s.data()?;
    replay_calendar(&d.activity, d.bucket, &s.request.as_ref()?.range, dates::now_ms())
}

/// The days tile's label.
fn days_label(app: &App) -> &'static str {
    bento::days_label(calendar(app).as_ref())
}

#[test]
fn asks_for_plays_by_day_and_caches_them_under_the_daily_key() {
    let daily = answer("day", 10);
    let server = MockServer::start(vec![res(&daily)]);
    let mut app = app(&server, true);
    go(&mut app, "/replay");

    let q = replay_queries(Period::ThisYear, dates::now_ms());
    let reqs = server.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(param(&reqs[0], "from"), q.range.from);
    assert_eq!(param(&reqs[0], "to"), q.range.to);
    assert_eq!(param(&reqs[0], "bucket").as_deref(), Some("day"));
    assert_eq!(app.pages.replay.cache.get(&q.daily.cache_key), Some(&data(&daily)));
    assert_eq!(days_label(&app), "Days with plays");
    assert_eq!(app.pages.replay.queue.len(), 2);
}

#[test]
fn asks_all_time_again_by_month_when_the_daily_series_was_cut_short_and_keeps_that_apart_from_the_daily_key() {
    let monthly = answer("month", 10);
    let server = MockServer::start(vec![res(&answer("day", 4)), res(&monthly)]);
    let mut app = app(&server, true);
    let q = replay_queries(Period::All, dates::now_ms());
    // An earlier daily answer, from before the history outgrew the cap.
    app.pages.replay.cache.store(&q, &q.daily, data(&answer("day", 10)));
    go(&mut app, "/replay?period=all");

    let reqs = server.requests();
    assert_eq!(reqs.len(), 2);
    for (req, bucket) in reqs.iter().zip(["day", "month"]) {
        assert_eq!((param(req, "from"), param(req, "to")), (None, None));
        assert_eq!(param(req, "bucket").as_deref(), Some(bucket));
    }
    assert_eq!(days_label(&app), "Months with plays");
    let c = calendar(&app).unwrap();
    assert_eq!(c.unit, CalendarUnit::Month);
    // Never under the daily key, which Home reads as days; and the old daily
    // answer is gone, so it can't come back in front of this one.
    let s = &app.pages.replay.cache;
    assert_eq!(s.get(&q.monthly.as_ref().unwrap().cache_key), Some(&data(&monthly)));
    assert_eq!(s.get(&q.daily.cache_key), None);
}

#[test]
fn asks_all_time_by_month_straight_away_once_it_has_come_back_by_month() {
    let fresh = answer("month", 10);
    let server = MockServer::start(vec![res(&fresh)]);
    let mut app = app(&server, true);
    let q = replay_queries(Period::All, dates::now_ms());
    let monthly = q.monthly.clone().unwrap();
    app.pages.replay.cache.store(&q, &monthly, data(&answer("month", 10)));
    go(&mut app, "/replay?period=all");

    // One request, by month: no thousands of days fetched only to be dropped.
    let reqs = server.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(param(&reqs[0], "bucket").as_deref(), Some("month"));
    assert_eq!(app.pages.replay.cache.get(&monthly.cache_key), Some(&data(&fresh)));
    assert_eq!(app.pages.replay.cache.get(&q.daily.cache_key), None);
    assert_eq!(days_label(&app), "Months with plays");
}

#[test]
fn never_asks_a_bounded_period_by_month_even_when_its_days_look_cut_short() {
    let q = replay_queries(Period::ThisYear, dates::now_ms());
    assert!(q.monthly.is_none());
    let short = answer("day", 4);
    let server = MockServer::start(vec![res(&short)]);
    let mut app = app(&server, true);
    go(&mut app, "/replay");

    let reqs = server.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(param(&reqs[0], "bucket").as_deref(), Some("day"));
    // Still under the key Home shares.
    assert_eq!(app.pages.replay.cache.get(&q.daily.cache_key), Some(&data(&short)));
    assert_eq!(days_label(&app), "Days with plays");
}

#[test]
fn names_what_the_loading_bentos_days_tile_counts_only_when_its_known() {
    // All time: by day or by month, nothing says which until it answers.
    assert!(replay_queries(Period::All, dates::now_ms()).monthly.is_some());
    // A bounded period always counts days.
    for p in [Period::Last30, Period::ThisMonth, Period::ThisYear, Period::Year(2025)] {
        assert!(replay_queries(p, dates::now_ms()).monthly.is_none(), "{p:?}");
    }
}

#[test]
fn opens_on_the_last_30_days_home_already_loaded_while_it_refreshes() {
    let from_home = answer("day", 10);
    let server = MockServer::start(vec![res(&from_home).delay(Duration::from_millis(300))]);
    let mut app = app(&server, false);
    let q = replay_queries(Period::Last30, dates::now_ms());
    app.pages.replay.cache.store(&q, &q.daily, data(&from_home));
    app.navigate(Location::parse("/replay?period=last-30"));
    // On screen at once, before the refresh lands.
    assert_eq!(app.pages.replay.data(), Some(&data(&from_home)));
    assert_eq!(app.pages.replay.queue.len(), 2);
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.requests().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(param(&server.requests()[0], "bucket").as_deref(), Some("day"));
}

fn replay_track(id: &str, plays: u64, artist: &str, credits: Option<Vec<(&str, &str, bool)>>) -> ReplayTrack {
    ReplayTrack {
        track: TrackListItem { id: id.into(), title: format!("Track {id}"), artist: Some(artist.into()), duration_ms: 200_000, ..Default::default() },
        plays,
        primary_artists: credits
            .map(|c| c.into_iter().map(|(id, name, has_page)| ReplayTrackArtist { id: id.into(), name: name.into(), has_page }).collect()),
    }
}

#[test]
fn opens_a_top_artists_page_when_they_have_one_plays_them_when_they_dont_and_links_only_artists_with_a_page() {
    let tracks = vec![
        replay_track(
            "a",
            6,
            "Earth, Wind & Fire, Kestrel Bay",
            Some(vec![("ar-ewf", "Earth, Wind & Fire", false), ("ar-kestrel", "Kestrel Bay", true)]),
        ),
        replay_track("b", 4, "Kestrel Bay", None),
    ];
    let artist = |id: &str, name: &str, plays, has_page| ReplayArtist { id: id.into(), name: name.into(), plays, has_page: Some(has_page) };
    let artists = vec![artist("ar-kestrel", "Kestrel Bay", 10, true), artist("ar-ewf", "Earth, Wind & Fire", 6, false), artist("ar-gone", "Gone", 1, false)];
    let own = top_artist_tracks(&artists, &tracks);
    let action = |a: &ReplayArtist| {
        let list: Vec<TrackListItem> = own[&a.id].iter().map(|t| t.track.clone()).collect();
        top_artist_action(a.has_page, &list)
    };
    assert_eq!(action(&artists[0]), Some(TopArtistAction::Open));
    assert_eq!(crate::ui::cards::artist_href("ar-kestrel"), "/library?view=artists&artist=ar-kestrel");
    // Playing them plays their top tracks: here the one they're credited on.
    assert_eq!(action(&artists[1]), Some(TopArtistAction::Play));
    assert_eq!(own["ar-ewf"].iter().map(|t| t.track.id.as_str()).collect::<Vec<_>>(), ["a"]);
    assert_eq!(action(&artists[2]), None);

    // The most played track's artists: whole names, linked only with a page.
    let links = replay_track_artists(tracks[0].track.artist.as_deref(), tracks[0].primary_artists.as_deref());
    let linked: Vec<(&str, Option<&str>)> = links.iter().map(|l| (l.name.as_str(), l.artist_id.as_deref())).collect();
    assert_eq!(linked, [("Earth, Wind & Fire", None), ("Kestrel Bay", Some("ar-kestrel"))]);
}

#[test]
fn leaves_the_most_played_tracks_artists_unlinked_when_the_server_doesnt_list_them() {
    let t = replay_track("a", 6, "Earth, Wind & Fire", None);
    let links = replay_track_artists(t.track.artist.as_deref(), None);
    assert_eq!(links.len(), 1);
    assert_eq!((links[0].name.as_str(), links[0].artist_id.as_deref()), ("Earth, Wind & Fire", None));
    // Without has_page the tile plays, as it would on Home.
    let a = ReplayArtist { id: "ar-ewf".into(), name: "Earth, Wind & Fire".into(), plays: 6, has_page: None };
    let own = top_artist_tracks(std::slice::from_ref(&a), &[t]);
    let list: Vec<TrackListItem> = own["ar-ewf"].iter().map(|t| t.track.clone()).collect();
    assert_eq!(top_artist_action(a.has_page, &list), Some(TopArtistAction::Play));
}

// replay-period-link.test.tsx

fn empty_answer(years: &[i32]) -> Res {
    let v = serde_json::json!({
        "summary": { "total_plays": 0, "total_ms": 0, "unique_tracks": 0, "unique_artists": 0 },
        "top_tracks": [], "top_artists": [], "top_albums": [], "top_genres": [], "activity": [], "bucket": "day",
        "available_years": years,
    });
    res(&v)
}

fn days(req: &Req) -> i64 {
    let from = dates::parse(&param(req, "from").unwrap()).unwrap();
    let to = dates::parse(&param(req, "to").unwrap()).unwrap();
    (to - from) / DAY_MS
}

fn starts_this_year(req: &Req) -> bool {
    param(req, "from").is_some_and(|f| f.starts_with(&format!("{}-01-01", year())))
}

/// The years the page knows have plays, as an earlier answer left them.
fn know_years(app: &mut App, years: &[i32]) {
    let q = replay_queries(Period::Year(1990), dates::now_ms());
    let d = ReplayData { available_years: years.to_vec(), ..ReplayData::default() };
    app.pages.replay.cache.store(&q, &q.daily, d);
}

#[test]
fn opens_on_the_period_a_link_names() {
    let server = MockServer::start(vec![empty_answer(&[])]);
    let mut app = app(&server, true);
    go(&mut app, "/replay?period=last-30");
    assert_eq!(app.pages.replay.period, Period::Last30);
    assert_eq!(days(&server.requests()[0]), 30);
}

#[test]
fn opens_on_this_year_without_one_and_keeps_the_picked_period_in_the_url() {
    let server = MockServer::start(vec![empty_answer(&[])]);
    let mut app = app(&server, true);
    go(&mut app, "/replay");
    assert_eq!(app.pages.replay.period, Period::ThisYear);
    set_period(&mut app, Period::Last30);
    while Net::drain(&mut app) {}
    assert_eq!(app.location().search(), "?period=last-30");
    assert_eq!(days(server.requests().last().unwrap()), 30);
    // The pills replace the entry rather than add one.
    assert_eq!(app.history.entries.len(), 2);
    set_period(&mut app, Period::ThisYear);
    while Net::drain(&mut app) {}
    assert_eq!(app.location().search(), "");
    assert!(starts_this_year(server.requests().last().unwrap()));
}

#[test]
fn rewrites_a_value_that_isnt_a_period_or_names_this_year_to_the_default() {
    for value in ["bogus".to_string(), "this-year".to_string(), format!("year:{}", year())] {
        let server = MockServer::start(vec![empty_answer(&[])]);
        let mut app = app(&server, true);
        go(&mut app, &format!("/replay?period={value}"));
        assert_eq!(app.location().search(), "", "{value}");
        assert_eq!(app.pages.replay.period, Period::ThisYear, "{value}");
        assert!(server.requests().iter().all(starts_this_year), "{value}");
    }
}

#[test]
fn keeps_a_year_with_plays_and_selects_its_pill() {
    let server = MockServer::start(vec![empty_answer(&[2025])]);
    let mut app = app(&server, true);
    know_years(&mut app, &[2025]);
    go(&mut app, "/replay?period=year:2025");
    assert_eq!(app.location().search(), "?period=year%3A2025");
    assert_eq!(app.location().get("period"), Some("year:2025"));
    assert_eq!(app.pages.replay.period, Period::Year(2025));
    assert!(build_period_options(app.pages.replay.cache.years().unwrap(), year()).contains(&Period::Year(2025)));
}

#[test]
fn opens_this_year_for_a_year_without_plays_without_asking_for_it_once_the_years_are_known() {
    let server = MockServer::start(vec![empty_answer(&[2025])]);
    let mut app = app(&server, true);
    know_years(&mut app, &[2025]);
    go(&mut app, "/replay?period=year:1999");
    assert_eq!(app.location().search(), "");
    assert!(server.requests().iter().all(starts_this_year));
}

#[test]
fn drops_a_year_without_plays_when_the_first_answer_says_which_years_exist() {
    let server = MockServer::start(vec![empty_answer(&[2025])]);
    let mut app = app(&server, true);
    go(&mut app, "/replay?period=year:1999");
    assert_eq!(app.location().search(), "");
    assert_eq!(app.pages.replay.period, Period::ThisYear);
    assert!(starts_this_year(server.requests().last().unwrap()));
}

#[test]
fn show_all_resets_with_the_period_and_the_visit() {
    let server = MockServer::start(vec![empty_answer(&[])]);
    let mut app = app(&server, true);
    go(&mut app, "/replay");
    app.pages.replay.all_tracks = true;
    // A refetch at midnight (the same entry, the same period) keeps it.
    let loc = app.location().clone();
    enter(&mut app, &loc);
    assert!(app.pages.replay.all_tracks);
    set_period(&mut app, Period::Last30);
    assert!(!app.pages.replay.all_tracks);
    app.pages.replay.all_tracks = true;
    go(&mut app, "/recent");
    go(&mut app, "/replay?period=last-30");
    assert!(!app.pages.replay.all_tracks);
}

#[test]
fn spans_read_like_intl_format_range() {
    let d = |y: i64, m: i64, day: i64| dates::utc(y, m - 1, day);
    assert_eq!(span_label(d(2026, 1, 1), d(2026, 11, 6), CalendarUnit::Day), "Jan 1 – Nov 6, 2026");
    assert_eq!(span_label(d(2026, 11, 1), d(2026, 11, 6), CalendarUnit::Day), "Nov 1 – 6, 2026");
    assert_eq!(span_label(d(2025, 12, 30), d(2026, 1, 5), CalendarUnit::Day), "Dec 30, 2025 – Jan 5, 2026");
    assert_eq!(span_label(d(2026, 11, 6), d(2026, 11, 6), CalendarUnit::Day), "Nov 6, 2026");
    assert_eq!(span_label(d(2013, 3, 1), d(2026, 10, 1), CalendarUnit::Month), "Mar 2013 – Oct 2026");
    assert_eq!(span_label(d(2026, 1, 1), d(2026, 11, 1), CalendarUnit::Month), "Jan – Nov 2026");
    assert_eq!(span_label(d(2026, 11, 1), d(2026, 11, 1), CalendarUnit::Month), "Nov 2026");
}

#[test]
fn rates_read_like_to_locale_string() {
    assert_eq!(bento::format_rate(8.66), "8.7");
    assert_eq!(bento::format_rate(2.25), "2.3");
    assert_eq!(bento::format_rate(3.0), "3");
    assert_eq!(bento::format_rate(10.5), "11");
    assert_eq!(bento::format_rate(1234.56), "1,235");
}
