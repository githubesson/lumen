//! `core/tests/track-info.test.ts`.

use super::*;
use crate::api::tidal::{TidalContributor, TidalCredit, TidalTrackArtist};

fn values(rows: &[TrackInfoCredit]) -> Vec<(String, String)> {
    rows.iter().map(|r| (r.label.clone(), r.value.clone())).collect()
}

fn lv(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(l, v)| (l.to_string(), v.to_string())).collect()
}

fn tidal_artist(name: &str, id: &str) -> TrackInfoName {
    TrackInfoName::artist(name, EntityKind::Tidal, id)
}

fn library_artist(name: &str, id: &str) -> TrackInfoName {
    TrackInfoName::artist(name, EntityKind::Local, id)
}

fn plain(name: &str) -> TrackInfoName {
    TrackInfoName::plain(name)
}

fn ta(name: &str, role: TidalArtistRole, id: Option<&str>) -> TidalTrackArtist {
    TidalTrackArtist { id: id.map(Into::into), name: name.into(), role }
}

fn credit(role: &str, names: &[&str]) -> TidalCredit {
    TidalCredit { role: role.into(), names: names.iter().map(|s| s.to_string()).collect(), contributors: None }
}

fn people(role: &str, people: &[(Option<&str>, &str)]) -> TidalCredit {
    TidalCredit {
        role: role.into(),
        names: people.iter().map(|(_, n)| n.to_string()).collect(),
        contributors: Some(people.iter().map(|(id, n)| TidalContributor { id: id.map(Into::into), name: n.to_string() }).collect()),
    }
}

fn artist(id: &str, name: &str, role: &str) -> TrackArtist {
    TrackArtist { id: id.into(), name: name.into(), role: role.into() }
}

use TidalArtistRole::{Featured, Main};

fn credits_info(f: impl FnOnce(&mut TidalTrackInfo)) -> TidalTrackInfo {
    let mut i = TidalTrackInfo {
        id: "1".into(),
        artists: vec![ta("Main", Main, None), ta("Co", Main, None), ta("Guest", Featured, None)],
        credits: vec![
            credit("Composer", &["Writer"]),
            credit("Producer", &["Maker"]),
            credit("Mixing Engineer", &["Mixer"]),
            credit("producer", &["Maker", "Second"]),
            credit("A&R Administrator", &["Scout"]),
            credit("Vocal", &[]),
        ],
        ..Default::default()
    };
    f(&mut i);
    i
}

fn stored() -> Vec<TrackArtist> {
    vec![artist("a", "Main", "primary"), artist("b", "Co", "featured")]
}

#[test]
fn formatters() {
    assert_eq!(format_sample_rate(Some(96_000.0)), "96 kHz");
    assert_eq!(format_sample_rate(Some(88_200.0)), "88.2 kHz");
    assert_eq!(format_bitrate(Some(1_411_200.0)), "1411 kbps");
    for v in [None, Some(0.0), Some(-1.0), Some(f64::NAN), Some(f64::INFINITY)] {
        assert_eq!(format_sample_rate(v), "—");
        assert_eq!(format_bitrate(v), "—");
    }
    assert_eq!(format_duration_ms(Some(0.0), "—"), "—");
    assert_eq!(format_calendar_date(Some("1969-01-01")), "Jan 1, 1969");
    for v in [None, Some(""), Some("2023"), Some("2023-02-30"), Some("2023-03-17T00:00:00Z"), Some("17/03/2023")] {
        assert_eq!(format_calendar_date(v), "—");
    }
}

#[test]
fn track_credit_rows() {
    let rows = track_credits(
        &[artist("1", "A", "primary"), artist("2", "B", "primary"), artist("3", "F", "featured"), artist("4", "C", "composer")],
        None,
    );
    let got: Vec<(String, String)> = rows.iter().map(|r| (r.label.clone(), r.value.clone())).collect();
    assert_eq!(got, lv(&[("Primary artist", "A, B"), ("Featured", "F"), ("Producers", "C")]));
    assert_eq!(track_credits(&[artist("4", "C", "composer")], Some("  Tag Writer "))[2].value, "Tag Writer");
    assert_eq!(track_credits(&[], Some(" ")).map(|r| r.value), ["—", "—", "—"]);
}

#[test]
fn uses_tidals_artists_and_every_role() {
    assert_eq!(
        values(&tidal_track_credits(&stored(), None, &credits_info(|_| {}))),
        lv(&[
            ("Primary artist", "Main, Co"),
            ("Featured", "Guest"),
            ("Producers", "Maker, Second"),
            ("Composer", "Writer"),
            ("Mixing engineer", "Mixer"),
            ("A&R administrator", "Scout"),
        ])
    );
    let rows = tidal_track_credits(&stored(), None, &credits_info(|i| i.artists = vec![ta("Main", Main, None)]));
    assert_eq!((rows[1].label.as_str(), rows[1].value.as_str()), ("Featured", "—"));
}

#[test]
fn falls_back_to_the_stored_track() {
    let rows = tidal_track_credits(
        &stored(),
        None,
        &credits_info(|i| {
            i.artists.clear();
            i.credits.clear();
        }),
    );
    assert_eq!(values(&rows), lv(&[("Primary artist", "Main"), ("Featured", "Co"), ("Producers", "—")]));
    assert_eq!(rows[0].names, Some(vec![plain("Main")]));
    assert_eq!(rows[1].names, Some(vec![plain("Co")]));
}

#[test]
fn links_names_tidal_gives_ids() {
    let rows = tidal_track_credits(
        &stored(),
        None,
        &credits_info(|i| {
            i.artists = vec![ta("Main", Main, Some("9")), ta("Co", Main, None), ta("Guest", Featured, Some("7"))];
            i.credits = vec![
                people("Producer", &[(Some("24"), "Maker"), (None, "Second")]),
                people("producer", &[(Some("18"), "Second")]),
                credit("Composer", &["Writer"]),
            ];
        }),
    );
    let names: Vec<Option<Vec<TrackInfoName>>> = rows.iter().map(|r| r.names.clone()).collect();
    assert_eq!(
        names,
        [
            Some(vec![tidal_artist("Main", "9"), plain("Co")]),
            Some(vec![tidal_artist("Guest", "7")]),
            Some(vec![tidal_artist("Maker", "24"), tidal_artist("Second", "18")]),
            Some(vec![plain("Writer")]),
        ]
    );
    assert_eq!(rows[2].value, "Maker, Second");
}

#[test]
fn keeps_namesakes_apart() {
    let rows = tidal_track_credits(
        &stored(),
        None,
        &credits_info(|i| {
            i.credits = vec![
                people("Engineer", &[(Some("1"), "Sam Lee"), (Some("2"), "Sam Lee"), (Some("1"), "Sam Lee")]),
                credit("engineer", &["Sam Lee"]),
            ];
        }),
    );
    assert_eq!(
        rows[3],
        TrackInfoCredit {
            label: "Engineer".into(),
            value: "Sam Lee, Sam Lee".into(),
            names: Some(vec![tidal_artist("Sam Lee", "1"), tidal_artist("Sam Lee", "2")]),
        }
    );
}

fn audio_info(streamed: Option<TidalStreamQuality>, max: Option<TidalStreamQuality>) -> TidalTrackInfo {
    TidalTrackInfo { id: "1".into(), streamed_quality: streamed, max_quality: max, ..Default::default() }
}

fn ar(label: &str, value: &str, wide: bool) -> AudioRow {
    AudioRow { label: label.into(), value: value.into(), wide }
}

#[test]
fn audio_rows() {
    use TidalStreamQuality::*;
    assert_eq!(
        tidal_audio_rows(Some(&audio_info(Some(Lossless), Some(HiResLossless)))),
        [ar("Format", "FLAC", false), ar("Quality", "Lossless", false), ar("Bit depth", "16-bit", false), ar("Sample rate", "44.1 kHz", false)]
    );
    assert!(tidal_audio_rows(Some(&audio_info(Some(HiResLossless), None))).contains(&ar("Sample rate", "Up to 192 kHz", false)));
    assert_eq!(
        tidal_audio_rows(Some(&audio_info(Some(High), None))),
        [ar("Format", "AAC", false), ar("Quality", "Lossy", false), ar("Bitrate", "320 kbps", false)]
    );
    assert_eq!(
        tidal_audio_rows(Some(&audio_info(None, Some(Lossless)))),
        [ar("Quality", "Up to Lossless (16-bit / 44.1 kHz FLAC)", true)]
    );
    assert_eq!(tidal_audio_rows(Some(&audio_info(None, Some(Low))))[0].value, "Up to AAC 96 kbps");
    for unknown in [None, Some(audio_info(None, None)), Some(audio_info(Some(Unknown), None))] {
        assert_eq!(tidal_audio_rows(unknown.as_ref()), [ar("Quality", "—", false)]);
    }
}

#[test]
fn refusals() {
    let refusal = "TIDAL refused this track: Not available in your region";
    assert_eq!(tidal_refusal_message(&ApiError::http(502, refusal)).as_deref(), Some(refusal));
    assert_eq!(tidal_refusal_message(&ApiError::http(502, "tidal track unavailable")), None);
    assert_eq!(tidal_refusal_message(&ApiError::http(500, refusal)), None);
    assert_eq!(tidal_refusal_message(&ApiError::transport(refusal)), None);
}

fn file(f: impl FnOnce(&mut TrackDetail)) -> TrackDetail {
    let mut t: TrackDetail = serde_json::from_str(
        r#"{"id":"t1","source":"local","title":"Song","duration_ms":185000,"format":"FLAC","file_size":31457280,
        "artists":[{"id":"a","name":"Main","role":"primary"}],"has_cover":true,"favorited":false}"#,
    )
    .unwrap();
    f(&mut t);
    t
}

#[test]
fn info_results() {
    let info = TidalTrackInfo { id: "77".into(), ..Default::default() };
    assert_eq!(track_info_tidal_id(Some(&file(|t| {
        t.source = TrackSource::Tidal;
        t.source_id = Some("77".into());
    }))).as_deref(), Some("77"));
    assert_eq!(track_info_tidal_id(Some(&file(|t| t.source = TrackSource::Tidal))), None);
    assert_eq!(track_info_tidal_id(Some(&file(|t| t.source_id = Some("77".into())))), None);
    assert_eq!(track_info_tidal_id(None), None);
    let r = |info: Option<TidalTrackInfo>, failed, refusal: Option<&str>| TidalTrackInfoResult {
        info,
        failed,
        refusal: refusal.map(Into::into),
    };
    assert_eq!(tidal_track_info_result(Some("77"), Some(&info), None), r(Some(info.clone()), false, None));
    assert_eq!(tidal_track_info_result(Some("78"), Some(&info), None), r(None, true, None));
    assert_eq!(tidal_track_info_result(Some("77"), None, None), r(None, true, None));
    assert_eq!(tidal_track_info_result(None, Some(&info), None), r(None, false, None));
    let refusal = "TIDAL refused this track: Not available in your region";
    assert_eq!(
        tidal_track_info_result(Some("77"), Some(&info), Some(&ApiError::http(502, refusal))),
        r(None, true, Some(refusal))
    );
    assert_eq!(tidal_track_info_result(Some("77"), None, Some(&ApiError::transport("timeout"))).refusal, None);
}

fn rows_of(view: &TrackInfoView, key: SectionKey) -> Vec<TrackInfoRow> {
    view.sections.iter().find(|s| s.key == key).map(|s| s.rows.clone()).unwrap_or_default()
}

fn r(label: &str, value: &str) -> TrackInfoRow {
    TrackInfoRow { label: label.into(), value: value.into(), ..Default::default() }
}

fn wide(label: &str, value: &str) -> TrackInfoRow {
    TrackInfoRow { wide: true, ..r(label, value) }
}

fn empty(label: &str) -> TrackInfoRow {
    TrackInfoRow { empty: true, ..r(label, "—") }
}

fn named(label: &str, value: &str, names: Vec<TrackInfoName>) -> TrackInfoRow {
    TrackInfoRow { names: Some(names), ..r(label, value) }
}

#[test]
fn lists_a_files_rows() {
    let view = track_info_rows(
        &file(|t| {
            t.year = Some(2001);
            t.genre = Some("Jazz".into());
            t.track_no = Some(3);
            t.comments = Some("Live take".into());
            t.bitrate = Some(900_000);
            t.sample_rate = Some(44_100);
            t.channels = Some(2);
            t.file_name = Some("song.flac".into());
        }),
        None,
        None,
    );
    assert_eq!(view.note, None);
    let labels: Vec<&str> = view.sections.iter().map(|s| s.label.as_str()).collect();
    assert_eq!(labels, ["Credits", "Release", "Audio"]);
    assert_eq!(
        rows_of(&view, SectionKey::Credits),
        [named("Primary artist", "Main", vec![library_artist("Main", "a")]), empty("Featured"), empty("Producers")]
    );
    assert_eq!(
        rows_of(&view, SectionKey::Release),
        [r("Year", "2001"), r("Genre", "Jazz"), r("Track", "3"), wide("Comments", "Live take")]
    );
    assert_eq!(
        rows_of(&view, SectionKey::Audio),
        [
            r("Format", "FLAC"),
            r("Bitrate", "900 kbps"),
            r("Sample rate", "44.1 kHz"),
            r("Channels", "2"),
            r("Duration", "3:05"),
            r("File size", "30.0 MB"),
            wide("File", "song.flac"),
        ]
    );
}

#[test]
fn hides_empty_sections_and_cleans_text() {
    let view = track_info_rows(
        &file(|t| {
            t.genre = Some("  ".into());
            t.format = String::new();
            t.file_size = 0;
            t.duration_ms = 0;
        }),
        None,
        None,
    );
    let keys: Vec<SectionKey> = view.sections.iter().map(|s| s.key).collect();
    assert_eq!(keys, [SectionKey::Credits]);
    let view = track_info_rows(
        &file(|t| {
            t.genre = Some("Rock Â· Pop".into());
            t.artists = vec![artist("a", "A Â· B", "primary")];
        }),
        None,
        None,
    );
    assert_eq!(rows_of(&view, SectionKey::Credits)[0].value, "A · B");
    assert_eq!(rows_of(&view, SectionKey::Release)[0], r("Genre", "Rock · Pop"));
}

fn tidal_track() -> TrackDetail {
    file(|t| {
        t.source = TrackSource::Tidal;
        t.source_id = Some("77".into());
        t.format = String::new();
        t.file_size = 0;
        t.year = Some(1999);
    })
}

fn full_info(f: impl FnOnce(&mut TidalTrackInfo)) -> TidalTrackInfo {
    let mut i = TidalTrackInfo {
        id: "77".into(),
        artists: vec![ta("Main", Main, None)],
        credits: vec![credit("Producer", &["Maker"])],
        release_date: Some("2020-03-17".into()),
        bpm: Some(120.0),
        key: Some("F♯ minor".into()),
        isrc: Some("USXXX".into()),
        copyright: Some("℗ 2020 Label".into()),
        streamed_quality: Some(TidalStreamQuality::Lossless),
        channels: Some(2),
        ..Default::default()
    };
    f(&mut i);
    i
}

fn ok(info: TidalTrackInfo) -> TidalTrackInfoResult {
    tidal_track_info_result(Some("77"), Some(&info), None)
}

fn failed(err: ApiError) -> TidalTrackInfoResult {
    tidal_track_info_result(Some("77"), None, Some(&err))
}

#[test]
fn fills_a_tidal_track_from_tidal() {
    let view = track_info_rows(&tidal_track(), Some(&ok(full_info(|_| {}))), None);
    assert_eq!(view.note, None);
    assert_eq!(
        rows_of(&view, SectionKey::Credits),
        [named("Primary artist", "Main", vec![plain("Main")]), empty("Featured"), named("Producers", "Maker", vec![plain("Maker")])]
    );
    assert_eq!(
        rows_of(&view, SectionKey::Release),
        [
            r("Released", &format_calendar_date(Some("2020-03-17"))),
            r("BPM", "120"),
            r("Key", "F♯ minor"),
            r("ISRC", "USXXX"),
            wide("Copyright", "℗ 2020 Label"),
        ]
    );
    let labels: Vec<String> = rows_of(&view, SectionKey::Audio).into_iter().map(|r| r.label).collect();
    assert_eq!(labels, ["Source", "Format", "Quality", "Bit depth", "Sample rate", "Channels", "Duration"]);
}

#[test]
fn falls_back_to_the_rows_year_and_passes_on_failures() {
    let info = full_info(|i| {
        i.release_date = None;
        i.credits_failed = Some(true);
        i.release_failure = Some("Only the stream start date is known.".into());
    });
    let view = track_info_rows(&tidal_track(), Some(&ok(info)), None);
    assert_eq!(rows_of(&view, SectionKey::Release)[0], r("Year", "1999"));
    let note = |k| view.sections.iter().find(|s| s.key == k).and_then(|s| s.note.clone());
    assert_eq!(note(SectionKey::Credits).as_deref(), Some("Couldn't load credits from TIDAL."));
    assert_eq!(note(SectionKey::Release).as_deref(), Some("Only the stream start date is known."));
}

#[test]
fn shows_the_row_when_tidal_didnt_answer() {
    let view = track_info_rows(&tidal_track(), Some(&failed(ApiError::transport("timeout"))), None);
    assert_eq!(view.note.as_deref(), Some("Couldn't load more from TIDAL, so some fields are missing."));
    assert_eq!(rows_of(&view, SectionKey::Audio), [r("Source", "TIDAL"), empty("Quality"), r("Duration", "3:05")]);
    let refusal = "TIDAL refused this track: Not available in your region";
    let view = track_info_rows(&tidal_track(), Some(&failed(ApiError::http(502, refusal))), None);
    assert_eq!(view.note.as_deref(), Some(refusal));
}

#[test]
fn links_a_files_artists_and_album() {
    let view = track_info_rows(
        &file(|t| {
            t.album_id = Some("al1".into());
            t.album_title = Some("Album".into());
            t.year = Some(2024);
            t.composer = Some("Clayco, Lukrative".into());
            t.artists = vec![
                artist("a", "Main", "primary"),
                artist("f", "Guest", "featured"),
                artist("c", "Clayco, Lukrative", "composer"),
            ];
        }),
        None,
        None,
    );
    assert_eq!(
        rows_of(&view, SectionKey::Credits),
        [
            named("Primary artist", "Main", vec![library_artist("Main", "a")]),
            named("Featured", "Guest", vec![library_artist("Guest", "f")]),
            r("Producers", "Clayco, Lukrative"),
        ]
    );
    assert_eq!(view.artists, [library_artist("Main", "a"), library_artist("Guest", "f")]);
    assert_eq!(
        view.album,
        Some(TrackInfoName {
            name: "Album".into(),
            link: Some(TrackInfoLink { kind: LinkKind::Album, source: EntityKind::Local, id: "al1".into() })
        })
    );
    assert_eq!(view.year, "2024");
}

#[test]
fn leaves_names_without_pages_plain() {
    let view = track_info_rows(
        &file(|t| {
            t.artists = vec![artist("", "Main", "primary")];
            t.album_title = Some("Loose".into());
        }),
        None,
        None,
    );
    assert_eq!(rows_of(&view, SectionKey::Credits)[0], named("Primary artist", "Main", vec![plain("Main")]));
    assert_eq!(view.album, Some(plain("Loose")));
    assert_eq!(view.year, "");
    assert_eq!(track_info_rows(&file(|_| {}), None, None).album, None);
    let view = track_info_rows(
        &file(|t| {
            t.album_id = Some("al1".into());
            t.album_title = Some("A Â· B".into());
            t.artists = vec![artist("a", "C Â· D", "primary")];
        }),
        None,
        None,
    );
    assert_eq!(view.artists, [library_artist("C · D", "a")]);
    assert_eq!(view.album.map(|a| a.name).as_deref(), Some("A · B"));
}

#[test]
fn links_a_tidal_tracks_names_to_tidal() {
    let mut track = tidal_track();
    track.album_id = Some("hidden".into());
    track.source_album_id = Some("500".into());
    track.album_title = Some("Album".into());
    let info = full_info(|i| {
        i.artists = vec![ta("Main", Main, Some("9")), ta("Guest", Featured, Some("7"))];
        i.credits = vec![people("Producer", &[(Some("24"), "Maker"), (None, "Other")])];
    });
    let view = track_info_rows(&track, Some(&ok(info)), None);
    assert_eq!(view.artists, [tidal_artist("Main", "9"), tidal_artist("Guest", "7")]);
    assert_eq!(rows_of(&view, SectionKey::Credits)[2].names, Some(vec![tidal_artist("Maker", "24"), plain("Other")]));
    let album = TrackInfoName {
        name: "Album".into(),
        link: Some(TrackInfoLink { kind: LinkKind::Album, source: EntityKind::Tidal, id: "500".into() }),
    };
    assert_eq!(view.album, Some(album.clone()));
    assert_eq!(view.year, "2020");
    let fail = track_info_rows(&track, Some(&failed(ApiError::transport("timeout"))), None);
    assert_eq!(fail.artists, [plain("Main")]);
    assert_eq!(fail.album, Some(album));
    assert_eq!(fail.year, "1999");
}

#[test]
fn older_servers_link_the_primary_artist_through_the_album() {
    let mut track = tidal_track();
    track.source_album_id = Some("500".into());
    track.artists = vec![artist("h", "Main", "primary")];
    let old = ok(full_info(|i| i.artists = vec![ta("Main", Main, None), ta("Guest", Featured, None)]));
    let album = TidalAlbum { id: "500".into(), artist: Some("main ".into()), artist_id: Some("9".into()), ..Default::default() };

    let view = track_info_rows(&track, Some(&old), Some(&album));
    assert_eq!(view.artists, [tidal_artist("Main", "9"), plain("Guest")]);
    assert_eq!(rows_of(&view, SectionKey::Credits)[0].names, Some(vec![tidal_artist("Main", "9")]));
    assert_eq!(rows_of(&view, SectionKey::Credits)[1].names, Some(vec![plain("Guest")]));

    for other in [
        TidalAlbum { artist: Some("Various Artists".into()), ..album.clone() },
        TidalAlbum { artist_id: None, ..album.clone() },
        TidalAlbum { id: "501".into(), ..album.clone() },
    ] {
        assert_eq!(track_info_rows(&track, Some(&old), Some(&other)).artists, [plain("Main"), plain("Guest")]);
    }
    let local = track_info_rows(&file(|t| t.source_album_id = Some("500".into())), None, Some(&album));
    assert_eq!(local.artists, [library_artist("Main", "a")]);
}
