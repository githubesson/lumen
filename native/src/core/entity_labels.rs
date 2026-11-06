//! `core/src/entity-labels.ts`: subtitle and meta lines for albums and
//! artists: parts joined with " · ", counts through `pluralize`, names
//! cleaned with `displayText`.

use crate::api::tidal::TidalAlbum;
use crate::api::{Album, TrackSource};
use crate::format::{clean_text, fmt_total_ms, pluralize};

const SEPARATOR: &str = " · ";

fn join_parts<S: AsRef<str>>(parts: &[S]) -> String {
    parts.iter().map(AsRef::as_ref).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(SEPARATOR)
}

/// The artist a card credits an album to, with a fallback when it has none.
pub fn album_artist_name(artist_name: Option<&str>, is_compilation: bool) -> String {
    let name = clean_text(artist_name);
    if !name.is_empty() {
        name
    } else if is_compilation {
        "Various Artists".into()
    } else {
        "Unknown artist".into()
    }
}

/// "Artist · 12 tracks · TIDAL" for an album card or row. Rows that show
/// the track count on their own pass `show_track_count: false`.
pub fn album_subtitle(
    artist_name: Option<&str>,
    is_compilation: bool,
    track_count: u32,
    source: Option<TrackSource>,
    show_track_count: bool,
) -> String {
    join_parts(&[
        album_artist_name(artist_name, is_compilation),
        if show_track_count { pluralize(track_count as u64, "track") } else { String::new() },
        if source == Some(TrackSource::Tidal) { "TIDAL".into() } else { String::new() },
    ])
}

/// [`album_subtitle`] for a library album.
pub fn library_album_subtitle(album: &Album, show_track_count: bool) -> String {
    album_subtitle(album.artist_name.as_deref(), album.is_compilation, album.track_count, None, show_track_count)
}

/// `albumArtists`: who an album page credits: every main artist of a TIDAL
/// release when known (`names`), else the album artist. Empty when unknown.
pub fn album_artists(names: &[String], artist: Option<&str>) -> String {
    let joined = names.join(", ");
    if !joined.is_empty() {
        return clean_text(Some(&joined));
    }
    clean_text(artist.filter(|a| !a.is_empty()))
}

/// What an album page's facts are made of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AlbumMetaKey {
    Tracks,
    Saved,
    Year,
}

/// One fact on an album page, keyed so a page can style a kind of part.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlbumMetaPart {
    pub key: AlbumMetaKey,
    pub text: String,
}

fn album_meta_parts(track_count: u32, saved: Option<u32>, release_year: Option<i32>) -> Vec<AlbumMetaPart> {
    let mut parts = vec![AlbumMetaPart { key: AlbumMetaKey::Tracks, text: pluralize(track_count as u64, "track") }];
    if let Some(s) = saved {
        parts.push(AlbumMetaPart { key: AlbumMetaKey::Saved, text: format!("{s} saved") });
    }
    if let Some(y) = release_year.filter(|y| *y != 0) {
        parts.push(AlbumMetaPart { key: AlbumMetaKey::Year, text: y.to_string() });
    }
    parts
}

/// "12 tracks", "3 saved", "2021" under a library album page's title. Only
/// an album copying a TIDAL release has a part to save.
pub fn library_album_meta_parts(album: &Album) -> Vec<AlbumMetaPart> {
    let saved = if album.tidal_album_id.as_deref().is_some_and(|s| !s.is_empty()) { album.saved_count } else { None };
    album_meta_parts(album.track_count, saved, album.release_year)
}

/// The same for a TIDAL album page, where nothing saved is the usual case.
pub fn tidal_album_meta_parts(album: &TidalAlbum) -> Vec<AlbumMetaPart> {
    album_meta_parts(album.track_count, album.saved_count.filter(|s| *s != 0), album.release_year)
}

/// One artist an album page credits under its title.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlbumCredit {
    pub name: String,
    /// The library artist page the name opens; unset when there is none.
    pub artist_id: Option<String>,
}

/// What [`album_credits`] reads, from a library or a TIDAL album.
#[derive(Clone, Copy, Debug, Default)]
pub struct CreditsInput<'a> {
    pub artist_id: Option<&'a str>,
    pub artist_has_page: Option<bool>,
    pub artist_name: Option<&'a str>,
    pub artist_names: &'a [String],
    pub artists: &'a [String],
    pub artist: Option<&'a str>,
}

impl<'a> From<&'a Album> for CreditsInput<'a> {
    fn from(a: &'a Album) -> Self {
        CreditsInput {
            artist_id: a.artist_id.as_deref(),
            artist_has_page: a.artist_has_page,
            artist_name: a.artist_name.as_deref(),
            artist_names: &a.artist_names,
            ..Default::default()
        }
    }
}

impl<'a> From<&'a TidalAlbum> for CreditsInput<'a> {
    fn from(a: &'a TidalAlbum) -> Self {
        CreditsInput { artists: a.artists.as_deref().unwrap_or(&[]), artist: a.artist.as_deref(), ..Default::default() }
    }
}

/// `albumCredits`: the artists an album page credits, in order: every main
/// artist of a TIDAL release when known, else the album artist. Only the
/// album artist has a library id, and it links only when the server says
/// that artist has a page (`artist_has_page`).
pub fn album_credits(album: CreditsInput) -> Vec<AlbumCredit> {
    let single;
    let listed: Vec<Option<&str>> = if !album.artist_names.is_empty() {
        album.artist_names.iter().map(|s| Some(s.as_str())).collect()
    } else if !album.artists.is_empty() {
        album.artists.iter().map(|s| Some(s.as_str())).collect()
    } else {
        single = album.artist_name.filter(|s| !s.is_empty()).or(album.artist);
        vec![single]
    };
    let mut names: Vec<String> = Vec::new();
    for raw in listed {
        let name = clean_text(raw);
        if !name.is_empty() && !names.iter().any(|o| same_name(o, &name)) {
            names.push(name);
        }
    }
    let own = clean_text(album.artist_name);
    let linked = album.artist_id.is_some_and(|id| !id.is_empty()) && album.artist_has_page == Some(true) && !own.is_empty();
    names
        .into_iter()
        .map(|name| {
            let artist_id = (linked && same_name(&name, &own)).then(|| album.artist_id.unwrap_or("").to_string());
            AlbumCredit { name, artist_id }
        })
        .collect()
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// `creditsOnly`: whether a track credits only artists from `names` (an
/// album's), so the album's page can leave out its artist line. The track's
/// `artist` is its artists joined with ", "; a name holding the separator
/// is still one entry, so the credit has to split exactly into names from
/// the list. False for a track crediting no one.
pub fn credits_only(artist: Option<&str>, names: &[String]) -> bool {
    let credit = clean_text(artist).to_lowercase();
    let mut entries: Vec<String> = Vec::new();
    for n in names {
        let e = clean_text(Some(n)).to_lowercase();
        if !e.is_empty() && !entries.contains(&e) {
            entries.push(e);
        }
    }
    if credit.is_empty() {
        return false;
    }
    // Where an entry can start: the beginning, and after the separator that
    // follows an entry already matched. One pass in order visits them all.
    let mut starts = std::collections::BTreeSet::from([0usize]);
    let bytes = credit.as_bytes();
    for at in 0..credit.len() {
        if !starts.contains(&at) {
            continue;
        }
        for entry in &entries {
            if !bytes[at..].starts_with(entry.as_bytes()) {
                continue;
            }
            let end = at + entry.len();
            if end == credit.len() {
                return true;
            }
            if bytes[end..].starts_with(b", ") {
                starts.insert(end + 2);
            }
        }
    }
    false
}

/// `albumLength`: "12 tracks · 48 min". The time is left out when no track
/// has one, and a list under a minute reads "1 min".
pub fn album_length(durations_ms: &[u64]) -> String {
    let total: u64 = durations_ms.iter().sum();
    join_parts(&[
        pluralize(durations_ms.len() as u64, "track"),
        if total > 0 { fmt_total_ms(total.max(60_000)) } else { String::new() },
    ])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AlbumFactKey {
    Released,
    Length,
    Saved,
}

/// One fact in an album page's Details.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlbumFact {
    pub key: AlbumFactKey,
    pub label: String,
    pub value: String,
}

fn album_facts(durations_ms: &[u64], saved: Option<u32>, release_year: Option<i32>) -> Vec<AlbumFact> {
    let mut facts = Vec::new();
    if let Some(y) = release_year.filter(|y| *y != 0) {
        facts.push(AlbumFact { key: AlbumFactKey::Released, label: "Released".into(), value: y.to_string() });
    }
    facts.push(AlbumFact { key: AlbumFactKey::Length, label: "Length".into(), value: album_length(durations_ms) });
    if let Some(s) = saved {
        facts.push(AlbumFact {
            key: AlbumFactKey::Saved,
            label: "Saved".into(),
            value: format!("{s} of {}", pluralize(durations_ms.len() as u64, "track")),
        });
    }
    facts
}

/// A library album page's Details: the year when known, the length of its
/// list, and for an album copying a TIDAL release, how much of it is saved.
pub fn library_album_facts(album: &Album, durations_ms: &[u64]) -> Vec<AlbumFact> {
    let saved = if album.tidal_album_id.as_deref().is_some_and(|s| !s.is_empty()) { album.saved_count } else { None };
    album_facts(durations_ms, saved, album.release_year)
}

/// The same for a TIDAL album page, where Saved reads "None" rather than
/// going missing when nothing is.
pub fn tidal_album_facts(album: &TidalAlbum, durations_ms: &[u64]) -> Vec<AlbumFact> {
    let saved = album.saved_count.filter(|s| *s != 0);
    let mut facts = album_facts(durations_ms, saved, album.release_year);
    if saved.is_none() {
        facts.push(AlbumFact { key: AlbumFactKey::Saved, label: "Saved".into(), value: "None".into() });
    }
    facts
}

/// "12 tracks · 3 albums", or "TIDAL artist" for one from search.
pub fn artist_meta_parts(track_count: u32, album_count: u32, source: Option<TrackSource>) -> Vec<String> {
    let mut parts = vec![if source == Some(TrackSource::Tidal) {
        "TIDAL artist".to_string()
    } else {
        pluralize(track_count as u64, "track")
    }];
    if album_count > 0 {
        parts.push(pluralize(album_count as u64, "album"));
    }
    parts
}

pub fn artist_subtitle(track_count: u32, album_count: u32, source: Option<TrackSource>) -> String {
    join_parts(&artist_meta_parts(track_count, album_count, source))
}

/// "8 releases · 10 popular tracks" under a TIDAL artist page's name.
pub fn tidal_artist_meta_parts(release_count: usize, popular_track_count: usize) -> Vec<String> {
    let mut parts = Vec::new();
    if release_count > 0 {
        parts.push(pluralize(release_count as u64, "release"));
    }
    if popular_track_count > 0 {
        parts.push(pluralize(popular_track_count as u64, "popular track"));
    }
    parts
}

/// Meta parts joined for a single line.
pub fn meta_line<S: AsRef<str>>(parts: &[S]) -> String {
    join_parts(parts)
}

/// [`meta_line`] for album meta parts.
pub fn meta_line_parts(parts: &[AlbumMetaPart]) -> String {
    join_parts(&parts.iter().map(|p| p.text.as_str()).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn album(f: impl FnOnce(&mut Album)) -> Album {
        let mut a = Album { id: "a".into(), title: "A".into(), ..Default::default() };
        f(&mut a);
        a
    }

    fn tidal(f: impl FnOnce(&mut TidalAlbum)) -> TidalAlbum {
        let mut a = TidalAlbum { id: "t".into(), title: "T".into(), ..Default::default() };
        f(&mut a);
        a
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn texts(parts: &[AlbumMetaPart]) -> Vec<String> {
        parts.iter().map(|p| p.text.clone()).collect()
    }

    const MIN: u64 = 60_000;

    #[test]
    fn album_artist_fallbacks() {
        assert_eq!(album_artist_name(Some("Band"), false), "Band");
        assert_eq!(album_artist_name(None, true), "Various Artists");
        assert_eq!(album_artist_name(Some(""), false), "Unknown artist");
        assert_eq!(album_artist_name(Some("Foo Â· Bar"), false), "Foo · Bar");
        assert_eq!(album_artists(&s(&["Foo Â· Bar"]), None), "Foo · Bar");
    }

    #[test]
    fn card_parts_join_with_a_middle_dot() {
        assert_eq!(album_subtitle(Some("Band"), false, 1, None, true), "Band · 1 track");
        assert_eq!(album_subtitle(None, true, 12, Some(TrackSource::Tidal), true), "Various Artists · 12 tracks · TIDAL");
        assert_eq!(album_subtitle(Some("Band"), false, 12, Some(TrackSource::Tidal), false), "Band · TIDAL");
    }

    #[test]
    fn album_page_credits_every_main_artist() {
        assert_eq!(album_artists(&s(&["A", "B"]), Some("A")), "A, B");
        assert_eq!(album_artists(&[], Some("A")), "A");
        assert_eq!(album_artists(&[], None), "");
    }

    #[test]
    fn library_meta_parts() {
        assert_eq!(
            library_album_meta_parts(&album(|a| a.track_count = 1)),
            vec![AlbumMetaPart { key: AlbumMetaKey::Tracks, text: "1 track".into() }]
        );
        assert_eq!(
            library_album_meta_parts(&album(|a| {
                a.track_count = 12;
                a.tidal_album_id = Some("9".into());
                a.saved_count = Some(0);
                a.release_year = Some(2021);
            })),
            vec![
                AlbumMetaPart { key: AlbumMetaKey::Tracks, text: "12 tracks".into() },
                AlbumMetaPart { key: AlbumMetaKey::Saved, text: "0 saved".into() },
                AlbumMetaPart { key: AlbumMetaKey::Year, text: "2021".into() },
            ]
        );
        assert_eq!(
            texts(&library_album_meta_parts(&album(|a| {
                a.track_count = 12;
                a.saved_count = Some(4);
            }))),
            ["12 tracks"]
        );
        assert_eq!(
            texts(&library_album_meta_parts(&album(|a| {
                a.track_count = 12;
                a.tidal_album_id = Some("9".into());
            }))),
            ["12 tracks"]
        );
    }

    #[test]
    fn tidal_meta_parts() {
        assert_eq!(
            texts(&tidal_album_meta_parts(&tidal(|a| {
                a.track_count = 10;
                a.saved_count = Some(0);
                a.release_year = Some(2020);
            }))),
            ["10 tracks", "2020"]
        );
        assert_eq!(
            texts(&tidal_album_meta_parts(&tidal(|a| {
                a.track_count = 10;
                a.saved_count = Some(3);
            }))),
            ["10 tracks", "3 saved"]
        );
        let all = tidal(|a| {
            a.track_count = 10;
            a.saved_count = Some(3);
            a.release_year = Some(2020);
        });
        assert_eq!(meta_line_parts(&tidal_album_meta_parts(&all)), "10 tracks · 3 saved · 2020");
        assert_eq!(meta_line(&["a", "", "b"]), "a · b");
    }

    fn credit(name: &str, id: Option<&str>) -> AlbumCredit {
        AlbumCredit { name: name.into(), artist_id: id.map(Into::into) }
    }

    #[test]
    fn links_the_album_artist_with_a_page() {
        let a = album(|a| {
            a.artist_id = Some("ar-1".into());
            a.artist_name = Some("Band".into());
            a.artist_has_page = Some(true);
        });
        assert_eq!(album_credits((&a).into()), [credit("Band", Some("ar-1"))]);
        let a = album(|a| {
            a.artist_id = Some("ar-2".into());
            a.artist_name = Some("Earth, Wind & Fire".into());
            a.artist_has_page = Some(true);
        });
        assert_eq!(album_credits((&a).into()), [credit("Earth, Wind & Fire", Some("ar-2"))]);
    }

    #[test]
    fn leaves_the_album_artist_unlinked_without_a_page() {
        let a = album(|a| {
            a.artist_id = Some("ar-va".into());
            a.artist_name = Some("Various Artists".into());
            a.artist_has_page = Some(false);
        });
        assert_eq!(album_credits((&a).into()), [credit("Various Artists", None)]);
        let a = album(|a| {
            a.artist_id = Some("ar-1".into());
            a.artist_name = Some("Band".into());
        });
        assert_eq!(album_credits((&a).into()), [credit("Band", None)]);
        let a = album(|a| {
            a.artist_name = Some("Band".into());
            a.artist_has_page = Some(true);
        });
        assert_eq!(album_credits((&a).into()), [credit("Band", None)]);
    }

    #[test]
    fn credits_every_main_artist_of_a_tidal_release() {
        let a = album(|a| {
            a.artist_id = Some("ar-1".into());
            a.artist_name = Some("A".into());
            a.artist_has_page = Some(true);
            a.artist_names = s(&["A", "B", "a"]);
        });
        assert_eq!(album_credits((&a).into()), [credit("A", Some("ar-1")), credit("B", None)]);
        let t = tidal(|t| {
            t.artists = Some(s(&["A", "B"]));
            t.artist = Some("A".into());
        });
        assert_eq!(album_credits((&t).into()), [credit("A", None), credit("B", None)]);
        let t = tidal(|t| t.artist = Some("Foo Â· Bar".into()));
        assert_eq!(album_credits((&t).into()), [credit("Foo · Bar", None)]);
        assert_eq!(album_credits(CreditsInput::default()), []);
    }

    #[test]
    fn measures_the_lists_length() {
        assert_eq!(album_length(&[3 * MIN, 4 * MIN + MIN / 2, 2 * MIN]), "3 tracks · 9 min");
        assert_eq!(album_length(&[40 * MIN, 35 * MIN]), "2 tracks · 1 hr 15 min");
        assert_eq!(album_length(&[MIN / 2]), "1 track · 1 min");
        assert_eq!(album_length(&[0, 0, 2 * MIN]), "3 tracks · 2 min");
        assert_eq!(album_length(&[0]), "1 track");
        assert_eq!(album_length(&[]), "0 tracks");
    }

    fn fact(key: AlbumFactKey, label: &str, value: &str) -> AlbumFact {
        AlbumFact { key, label: label.into(), value: value.into() }
    }

    #[test]
    fn library_album_details() {
        assert_eq!(
            library_album_facts(&album(|a| a.release_year = Some(2021)), &[3 * MIN, 4 * MIN]),
            [fact(AlbumFactKey::Released, "Released", "2021"), fact(AlbumFactKey::Length, "Length", "2 tracks · 7 min")]
        );
        assert_eq!(library_album_facts(&album(|_| {}), &[3 * MIN]), [fact(AlbumFactKey::Length, "Length", "1 track · 3 min")]);
        let copy = album(|a| {
            a.tidal_album_id = Some("9".into());
            a.saved_count = Some(1);
            a.release_year = Some(2021);
        });
        let values: Vec<String> = library_album_facts(&copy, &[3 * MIN, 4 * MIN]).into_iter().map(|f| f.value).collect();
        assert_eq!(values, ["2021", "2 tracks · 7 min", "1 of 2 tracks"]);
        let keys: Vec<AlbumFactKey> =
            library_album_facts(&album(|a| a.saved_count = Some(1)), &[3 * MIN]).into_iter().map(|f| f.key).collect();
        assert_eq!(keys, [AlbumFactKey::Length]);
    }

    #[test]
    fn tidal_album_details_always_say_whats_saved() {
        assert_eq!(
            tidal_album_facts(
                &tidal(|t| {
                    t.saved_count = Some(0);
                    t.release_year = Some(2020);
                }),
                &[3 * MIN]
            ),
            [
                fact(AlbumFactKey::Released, "Released", "2020"),
                fact(AlbumFactKey::Length, "Length", "1 track · 3 min"),
                fact(AlbumFactKey::Saved, "Saved", "None"),
            ]
        );
        let values: Vec<String> = tidal_album_facts(&tidal(|_| {}), &[3 * MIN]).into_iter().map(|f| f.value).collect();
        assert_eq!(values, ["1 track · 3 min", "None"]);
        assert_eq!(
            tidal_album_facts(&tidal(|t| t.saved_count = Some(2)), &[3 * MIN, 3 * MIN, 3 * MIN]),
            [fact(AlbumFactKey::Length, "Length", "3 tracks · 9 min"), fact(AlbumFactKey::Saved, "Saved", "2 of 3 tracks")]
        );
    }

    #[test]
    fn artist_labels() {
        assert_eq!(artist_meta_parts(1, 0, None), ["1 track"]);
        assert_eq!(artist_subtitle(12, 2, None), "12 tracks · 2 albums");
        assert_eq!(artist_subtitle(0, 0, Some(TrackSource::Tidal)), "TIDAL artist");
        assert_eq!(artist_subtitle(0, 3, Some(TrackSource::Tidal)), "TIDAL artist · 3 albums");
        assert_eq!(tidal_artist_meta_parts(8, 1), ["8 releases", "1 popular track"]);
        assert_eq!(tidal_artist_meta_parts(0, 10), ["10 popular tracks"]);
        assert!(tidal_artist_meta_parts(0, 0).is_empty());
    }

    #[test]
    fn credits_only_matches_whole_entries() {
        let album = s(&["Halden Marsh", "Kestrel Bay"]);
        assert!(credits_only(Some("Halden Marsh"), &album));
        assert!(credits_only(Some("Kestrel Bay, Halden Marsh"), &album));
        assert!(credits_only(Some("halden marsh, KESTREL BAY"), &album));
        assert!(!credits_only(Some("Halden Marsh, Hana Okoro"), &album));
        assert!(!credits_only(Some("Hana Okoro"), &album));
        assert!(!credits_only(Some("Kestrel"), &album));
        assert!(!credits_only(Some("Kestrel Bay Band"), &album));

        let album = s(&["Earth, Wind & Fire", "Kestrel Bay"]);
        assert!(credits_only(Some("Earth, Wind & Fire"), &album));
        assert!(credits_only(Some("Kestrel Bay, Earth, Wind & Fire"), &album));
        assert!(!credits_only(Some("Earth"), &album));
        assert!(!credits_only(Some("Earth, Wind"), &album));
        assert!(!credits_only(Some("Earth, Wind & Fire, Hana Okoro"), &album));
        assert!(credits_only(Some("Wind & Fire, Earth"), &s(&["Earth", "Wind & Fire"])));

        assert!(!credits_only(None, &s(&["Band"])));
        assert!(!credits_only(Some("  "), &s(&["Band"])));
        assert!(!credits_only(Some("Band"), &[]));
        assert!(!credits_only(Some("Band"), &s(&[""])));
    }
}
