//! `core/tests/replay.test.ts` and `replay-labels-zone.test.ts`.

use super::*;
use crate::api::stats::ReplayAlbum;

const H: i64 = 3_600_000;

fn utc(y: i64, m: i64, d: i64) -> i64 {
    dates::utc(y, m - 1, d)
}

fn day(y: i64, m: i64, d: i64, plays: u64) -> ReplayActivityBucket {
    ReplayActivityBucket { bucket_start: dates::to_iso(utc(y, m, d)), plays }
}

fn range(from: &str, to: &str) -> ReplayRange {
    ReplayRange { from: Some(from.into()), to: Some(to.into()), bucket: None }
}

#[test]
fn keys_a_rolling_period_on_its_days() {
    let september = replay_request(Period::ThisMonth, dates::local_ms(2026, 8, 30, 12));
    let october = replay_request(Period::ThisMonth, dates::local_ms(2026, 9, 1, 12));
    assert_eq!(september.cache_key, "this-month:2026-09-01:2026-10-01");
    assert_eq!(october.cache_key, "this-month:2026-10-01:2026-11-01");
}

#[test]
fn keeps_the_last_30_key_within_a_day() {
    let morning = replay_request(Period::Last30, dates::utc(2026, 9, 2) + H);
    let evening = replay_request(Period::Last30, dates::utc(2026, 9, 2) + 22 * H);
    let tomorrow = replay_request(Period::Last30, dates::utc(2026, 9, 3) + H);
    assert_eq!(evening.cache_key, morning.cache_key);
    assert_ne!(evening.range.to, morning.range.to);
    assert_eq!(tomorrow.cache_key, "last-30:2026-09-03:2026-10-03");
    let all = replay_request(Period::All, 0);
    assert_eq!(all.range, ReplayRange { bucket: Some(ReplayBucket::Month), ..Default::default() });
    assert_eq!(all.cache_key, "all::");
}

#[test]
fn queries_by_day_under_one_key() {
    let now = dates::utc(2026, 9, 2) + 13 * H;
    let q = replay_queries(Period::Last30, now);
    assert_eq!(
        q.daily,
        ReplayQuery {
            params: ReplayParams { from: q.range.from.clone(), to: q.range.to.clone(), bucket: Some(ReplayBucket::Day) },
            cache_key: "replay:daily:last-30:2026-09-02:2026-10-02".into(),
        }
    );
    assert_eq!(q.range.bucket, Some(ReplayBucket::Day));
    assert_eq!(replay_queries(Period::ThisYear, now).daily.params.bucket, Some(ReplayBucket::Day));
    let all = replay_queries(Period::All, now);
    assert_eq!(all.daily.params, ReplayParams { from: None, to: None, bucket: Some(ReplayBucket::Day) });
    assert_eq!(all.daily.cache_key, "replay:daily:all::");
    let monthly = all.monthly.unwrap();
    assert_eq!(monthly.params.bucket, Some(ReplayBucket::Month));
    assert_eq!(monthly.cache_key, "replay:monthly:all::");
    for p in [Period::ThisYear, Period::Year(2025), Period::ThisMonth, Period::Last30] {
        assert_eq!(replay_queries(p, now).monthly, None, "{p:?}");
    }
    let morning = replay_queries(Period::Last30, dates::utc(2026, 9, 2) + H).daily.cache_key;
    assert_ne!(replay_queries(Period::Last30, dates::utc(2026, 9, 3) + H).daily.cache_key, morning);
}

#[test]
fn request_builders() {
    let period = Period::Year(2025);
    let r = replay_request(period, 0).range;
    assert_eq!(
        replay_playlist_request(period, &r, 0),
        ReplayPlaylistRequest {
            from: Some("2025-01-01T00:00:00.000Z".into()),
            to: Some("2026-01-01T00:00:00.000Z".into()),
            name: "Replay · 2025".into(),
            limit: 50,
        }
    );
    assert_eq!(
        replay_image_request(period, &r, 0),
        ReplayImageRequest { from: r.from.clone(), to: r.to.clone(), title: "2025".into() }
    );
    assert_eq!(replay_image_filename(period), "replay-year-2025.png");
    assert_eq!(replay_image_filename(Period::Last30), "replay-last-30.png");
    let all = replay_request(Period::All, 0).range;
    assert_eq!(
        replay_playlist_request(Period::All, &all, 0),
        ReplayPlaylistRequest { from: None, to: None, name: "Replay · All time".into(), limit: 50 }
    );
}

fn rt(id: &str, artist: Option<&str>, ids: Option<&[&str]>) -> ReplayTrack {
    ReplayTrack {
        track: TrackListItem { id: id.into(), artist: artist.map(Into::into), ..Default::default() },
        plays: 1,
        primary_artists: ids.map(|ids| {
            ids.iter().map(|i| ReplayTrackArtist { id: i.to_string(), name: i.to_string(), has_page: false }).collect()
        }),
    }
}

#[test]
fn plays_by_track() {
    let mut a = rt("a", None, None);
    a.plays = 3;
    let map = plays_by_id(&[a, rt("b", None, None)]);
    assert_eq!((map["a"], map["b"]), (3, 1));
    assert!(plays_by_id(&[]).is_empty());
}

fn ids<T: ArtistCredits + Clone>(id: Option<&str>, name: &str, list: &[T], key: impl Fn(&T) -> String) -> Vec<String> {
    tracks_by_artist(id, name, list).iter().map(key).collect()
}

#[test]
fn tracks_by_artist_name() {
    let tracks = [
        rt("solo", Some("Kestrel Bay"), None),
        rt("duet", Some("Halden Marsh, Kestrel Bay"), None),
        rt("comma", Some("Tyler, The Creator, Kali Uchis"), None),
        rt("ewf", Some("Earth, Wind & Fire"), None),
        rt("other", Some("Kestrel Bayside"), None),
        rt("lower", Some("kestrel bay"), None),
        rt("none", None, None),
    ];
    let key = |t: &ReplayTrack| t.track.id.clone();
    assert_eq!(ids(None, "Kestrel Bay", &tracks, key), ["solo", "duet", "lower"]);
    assert!(ids(None, "Bay", &tracks, key).is_empty());
    assert_eq!(ids(None, "Earth, Wind & Fire", &tracks, key), ["ewf"]);
    assert_eq!(ids(None, "Tyler, The Creator", &tracks, key), ["comma"]);
    assert_eq!(ids(None, "Kali Uchis", &tracks, key), ["comma"]);
    assert!(ids(None, "  ", &tracks, key).is_empty());
    let credited = [
        rt("ewf", Some("Earth, Wind & Fire"), Some(&["ar-ewf"])),
        rt("earth", Some("Earth"), Some(&["ar-earth"])),
        rt("both", Some("Earth, Earth, Wind & Fire"), Some(&["ar-earth", "ar-ewf"])),
    ];
    assert_eq!(ids(None, "Earth", &credited, key), ["ewf", "earth", "both"]);
    assert_eq!(ids(Some("ar-earth"), "Earth", &credited, key), ["earth", "both"]);
    assert_eq!(ids(Some("ar-ewf"), "Earth, Wind & Fire", &credited, key), ["ewf", "both"]);
}

fn artist(id: &str, name: &str) -> ReplayArtist {
    ReplayArtist { id: id.into(), name: name.into(), plays: 1, has_page: None }
}

#[test]
fn top_artist_track_lists() {
    let tracks = [
        rt("t1", Some("Hana Okoro, The Velvet Meridian"), None),
        rt("t2", Some("Halden Marsh"), None),
        rt("t3", Some("the velvet meridian"), None),
        rt("t4", Some("Earth, Wind & Fire"), None),
    ];
    let map = top_artist_tracks(
        &[
            artist("ar-velvet", "The Velvet Meridian"),
            artist("ar-halden", "Halden Marsh"),
            artist("ar-ewf", "Earth, Wind & Fire"),
            artist("ar-kestrel", "Kestrel Bay"),
        ],
        &tracks,
    );
    let of = |k: &str| map[k].iter().map(|t| t.track.id.clone()).collect::<Vec<_>>();
    assert_eq!(of("ar-velvet"), ["t1", "t3"]);
    assert_eq!(of("ar-halden"), ["t2"]);
    assert_eq!(of("ar-ewf"), ["t4"]);
    assert!(of("ar-kestrel").is_empty());
    let map = top_artist_tracks(
        &[artist("ar-ewf", "Earth, Wind & Fire"), artist("ar-earth", "Earth")],
        &[rt("t4", Some("Earth, Wind & Fire"), Some(&["ar-ewf"]))],
    );
    assert_eq!(map["ar-ewf"].len(), 1);
    assert!(map["ar-earth"].is_empty());
}

#[test]
fn top_artist_actions() {
    let track = TrackListItem { id: "t".into(), title: "T".into(), duration_ms: 1, ..Default::default() };
    assert_eq!(top_artist_action(Some(true), &[]), Some(TopArtistAction::Open));
    assert_eq!(top_artist_action(Some(false), std::slice::from_ref(&track)), Some(TopArtistAction::Play));
    assert_eq!(top_artist_action(None, std::slice::from_ref(&track)), Some(TopArtistAction::Play));
    assert_eq!(top_artist_action(Some(false), &[]), None);
    let gone = TrackListItem { unavailable: Some(true), ..track };
    assert_eq!(top_artist_action(Some(false), &[gone]), None);
}

#[test]
fn track_artist_links() {
    let primary = [
        ReplayTrackArtist { id: "ar-ewf".into(), name: "Earth, Wind & Fire".into(), has_page: true },
        ReplayTrackArtist { id: "ar-guest".into(), name: "Guest".into(), has_page: false },
    ];
    assert_eq!(
        replay_track_artists(Some("Earth, Wind & Fire, Guest"), Some(&primary)),
        [
            ArtistLink { name: "Earth, Wind & Fire".into(), artist_id: Some("ar-ewf".into()) },
            ArtistLink { name: "Guest".into(), artist_id: None }
        ]
    );
    assert_eq!(
        replay_track_artists(Some("Earth, Wind & Fire"), None),
        [ArtistLink { name: "Earth, Wind & Fire".into(), artist_id: None }]
    );
    assert!(replay_track_artists(None, None).is_empty());
}

#[test]
fn album_subtitles() {
    assert_eq!(replay_album_subtitle(Some(" A Â· B "), 1234), "A · B · 1,234 plays");
    assert_eq!(replay_album_subtitle(Some("Solo"), 1), "Solo · 1 play");
    assert_eq!(replay_album_subtitle(None, 2), "2 plays");
    assert_eq!(replay_album_subtitle(Some("Â"), 2), "2 plays");
    let _ = ReplayAlbum::default();
}

fn buckets(plays: &[u64]) -> Vec<ReplayActivityBucket> {
    plays.iter().enumerate().map(|(i, p)| day(2026, 1, i as i64 + 1, *p)).collect()
}

#[test]
fn chart_scale_and_labels() {
    assert_eq!(activity_chart_scale(&buckets(&[1, 5, 2]), 6), (5, 1));
    assert_eq!(activity_chart_scale(&buckets(&[0; 30]), 6), (0, 5));
    assert_eq!(activity_chart_scale(&buckets(&[1; 31]), 6).1, 6);
    assert_eq!(activity_chart_scale(&[], 6), (0, 1));
    let date = utc(2026, 3, 7);
    assert_eq!(activity_bucket_label(date, ReplayBucket::Day), "Mar 7");
    assert_eq!(activity_bucket_label(date, ReplayBucket::Week), "Mar 7");
    assert_eq!(activity_bucket_label(date, ReplayBucket::Month), "Mar 26");
    // Read in UTC whatever the local zone: a bucket at UTC midnight keeps its day.
    assert_eq!(activity_bucket_label(dates::parse("2026-03-01T00:00:00Z").unwrap(), ReplayBucket::Month), "Mar 26");
}

#[test]
fn genre_percentages() {
    let g = |genre: &str, plays| ReplayGenreSlice { genre: genre.into(), plays };
    let shares: Vec<f64> = genre_shares(&[g("Rock", 3), g("Jazz", 1)]).into_iter().map(|(_, s)| s).collect();
    assert_eq!(shares, [75.0, 25.0]);
    assert_eq!(genre_shares(&[g("Rock", 0)])[0].1, 0.0);
}

const NOW_H: i64 = 15 * H + 20 * 60_000;

fn now() -> i64 {
    utc(2026, 10, 13) + NOW_H
}

#[test]
fn day_spans() {
    let span = |first, last| Some(ReplayDaySpan { first, last });
    assert_eq!(
        replay_day_span(&range("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"), None, now()),
        span(utc(2026, 10, 1), utc(2026, 10, 13))
    );
    assert_eq!(
        replay_day_span(&range("2025-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"), None, now()),
        span(utc(2025, 1, 1), utc(2025, 12, 31))
    );
    let last30 = range(&dates::to_iso(now() - 30 * DAY_MS), &dates::to_iso(now()));
    let s = replay_day_span(&last30, None, now()).unwrap();
    assert_eq!(s, ReplayDaySpan { first: utc(2026, 9, 14), last: utc(2026, 10, 13) });
    assert_eq!((s.last - s.first) / DAY_MS + 1, 30);
    let activity = [day(2026, 3, 17, 4), day(2026, 6, 2, 1)];
    let all = ReplayRange::default();
    assert_eq!(replay_day_span(&all, Some(&activity), now()), span(utc(2026, 3, 17), utc(2026, 10, 13)));
    assert_eq!(replay_day_span(&all, Some(&[]), now()), None);
    assert_eq!(replay_day_span(&all, None, now()), None);
    let month = range("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    assert_eq!(replay_day_span(&month, Some(&[day(2026, 10, 14, 2)]), now()).map(|s| s.last), Some(utc(2026, 10, 14)));
    let early = ReplayActivityBucket { bucket_start: "2026-10-13T22:00:00Z".into(), plays: 1 };
    assert_eq!(replay_day_span(&month, Some(&[early]), now()).map(|s| s.last), Some(utc(2026, 10, 14)));
}

#[test]
fn calendars() {
    let this_month = range("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    let days = replay_calendar(
        &[day(2026, 10, 1, 3), day(2026, 10, 4, 5), day(2026, 10, 13, 1)],
        ReplayBucket::Day,
        &this_month,
        now(),
    )
    .unwrap();
    assert_eq!(days.unit, CalendarUnit::Day);
    assert_eq!(days.plays, [3, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    assert_eq!(days.with_plays, 3);
    assert!((plays_per_unit(9, Some(&days)).unwrap() - 9.0 / 13.0).abs() < 1e-9);

    let last30 = range(&dates::to_iso(now() - 30 * DAY_MS), &dates::to_iso(now()));
    let days = replay_calendar(
        &[day(2026, 9, 13, 7), day(2026, 9, 14, 2), day(2026, 10, 13, 4)],
        ReplayBucket::Day,
        &last30,
        now(),
    )
    .unwrap();
    assert_eq!(days.plays.len(), 30);
    assert_eq!((days.plays[0], days.plays[29], days.with_plays), (2, 4, 2));

    let months = replay_calendar(
        &[day(2025, 11, 1, 40), day(2026, 2, 1, 12), day(2026, 10, 1, 9)],
        ReplayBucket::Month,
        &ReplayRange::default(),
        now(),
    )
    .unwrap();
    assert_eq!(months.unit, CalendarUnit::Month);
    assert_eq!((months.first, months.last), (utc(2025, 11, 1), utc(2026, 10, 1)));
    assert_eq!(months.plays, [40, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 9]);
    assert_eq!(months.with_plays, 3);
    assert!((plays_per_unit(61, Some(&months)).unwrap() - 61.0 / 12.0).abs() < 1e-9);
    let early = replay_calendar(
        &[ReplayActivityBucket { bucket_start: "2026-09-30T22:00:00Z".into(), plays: 5 }],
        ReplayBucket::Month,
        &ReplayRange::default(),
        now(),
    )
    .unwrap();
    assert_eq!((early.first, early.plays.as_slice()), (utc(2026, 10, 1), &[5u64][..]));

    assert_eq!(replay_calendar(&[day(2026, 10, 5, 9)], ReplayBucket::Week, &this_month, now()), None);
    assert_eq!(replay_calendar(&[], ReplayBucket::Month, &ReplayRange::default(), now()), None);
    assert_eq!(plays_per_unit(9, None), None);
}

#[test]
fn series_completeness() {
    assert!(replay_series_complete(9, &[day(2026, 10, 1, 4), day(2026, 10, 2, 5)]));
    assert!(replay_series_complete(0, &[]));
    assert!(replay_series_complete(8, &[day(2026, 10, 1, 9)]));
    assert!(!replay_series_complete(12, &[day(2026, 10, 1, 9)]));
}

fn days_calendar() -> ReplayCalendar {
    ReplayCalendar {
        unit: CalendarUnit::Day,
        first: utc(2026, 1, 30),
        last: utc(2026, 3, 2),
        plays: (0..32).map(|i| if i % 10 == 0 { 2 } else { 0 }).collect(),
        with_plays: 4,
    }
}

fn b(iso: &str, plays: u64) -> ReplayActivityBucket {
    ReplayActivityBucket { bucket_start: iso.into(), plays }
}

#[test]
fn series_by_day_week_and_month() {
    let (bucket, buckets) = activity_series(&days_calendar(), ReplayBucket::Day);
    assert_eq!(bucket, ReplayBucket::Day);
    assert_eq!(buckets.len(), 32);
    assert_eq!(buckets[0], b("2026-01-30T00:00:00.000Z", 2));
    assert_eq!(buckets[1].plays, 0);
    assert_eq!(
        activity_series(&days_calendar(), ReplayBucket::Month).1,
        [b("2026-01-01T00:00:00.000Z", 2), b("2026-02-01T00:00:00.000Z", 4), b("2026-03-01T00:00:00.000Z", 2)]
    );
    let mut quiet = days_calendar();
    quiet.plays = quiet.plays.iter().enumerate().map(|(i, p)| if i < 3 { *p } else { 0 }).collect();
    let plays: Vec<u64> = activity_series(&quiet, ReplayBucket::Month).1.iter().map(|b| b.plays).collect();
    assert_eq!(plays, [2, 0, 0]);
    let weeks = activity_series(&days_calendar(), ReplayBucket::Week).1;
    assert_eq!(weeks[0], b("2026-01-26T00:00:00.000Z", 2));
    assert_eq!(weeks[1].bucket_start, "2026-02-02T00:00:00.000Z");
    assert_eq!(weeks.iter().map(|w| w.plays).sum::<u64>(), 8);
    let months = ReplayCalendar {
        unit: CalendarUnit::Month,
        first: utc(2025, 12, 1),
        last: utc(2026, 2, 1),
        plays: vec![3, 0, 7],
        with_plays: 2,
    };
    assert_eq!(
        activity_series(&months, ReplayBucket::Day),
        (
            ReplayBucket::Month,
            vec![b("2025-12-01T00:00:00.000Z", 3), b("2026-01-01T00:00:00.000Z", 0), b("2026-02-01T00:00:00.000Z", 7)]
        )
    );
}

#[test]
fn peaks() {
    let series = [day(2026, 10, 1, 3), day(2026, 10, 2, 8), day(2026, 10, 3, 8)];
    assert!(std::ptr::eq(activity_peak(&series).unwrap(), &series[1]));
    assert_eq!(activity_peak(&[day(2026, 10, 1, 0)]), None);
    assert_eq!(activity_peak(&[]), None);
}
