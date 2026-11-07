//! `core/src/artist-releases.ts`: an artist's discography: TIDAL releases
//! (newest first, classified as albums, EPs and singles, their explicit,
//! clean and Dolby Atmos versions folded into one tile) and library albums
//! grouped from the artist's tracks.

use crate::api::{SearchAlbum, TrackListItem, TrackSource};
use crate::core::entity_target::{EntityTarget, search_entity_target};
use crate::format::pluralize;

/// Popular tracks an artist page shows before "See more".
pub const ARTIST_POPULAR_PREVIEW_COUNT: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ReleaseKind {
    Album,
    Ep,
    Single,
}

impl ReleaseKind {
    pub fn label(self) -> &'static str {
        match self {
            ReleaseKind::Album => "Album",
            ReleaseKind::Ep => "EP",
            ReleaseKind::Single => "Single",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum ReleaseFilter {
    #[default]
    All,
    Albums,
    Singles,
}


/// `RELEASE_FILTER_OPTIONS`, in order.
pub const RELEASE_FILTER_OPTIONS: [(ReleaseFilter, &str); 3] =
    [(ReleaseFilter::All, "All"), (ReleaseFilter::Albums, "Albums"), (ReleaseFilter::Singles, "Singles & EPs")];

/// One tile in an artist's discography.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ArtistRelease {
    pub id: String,
    pub title: String,
    pub track_count: u32,
    pub release_year: Option<i32>,
    pub has_cover: Option<bool>,
    pub cover_url: Option<String>,
    /// Unset for library albums; with `source_id`, what the release opens.
    pub source: Option<TrackSource>,
    pub source_id: Option<String>,
    /// Unknown for library albums, which are grouped from the artist's tracks.
    pub kind: Option<ReleaseKind>,
    /// TIDAL releases, as on `SearchAlbum`.
    pub version: Option<String>,
    pub explicit: Option<bool>,
    pub dolby_atmos: Option<bool>,
    /// Set by [`fold_release_versions`] on a release TIDAL also lists in
    /// other versions: all of them, this one first.
    pub versions: Option<Vec<ArtistRelease>>,
}


/// The page a release opens.
pub fn release_target(r: &ArtistRelease) -> EntityTarget {
    search_entity_target(&r.id, r.source, r.source_id.as_deref())
}

/// Classify the way Spotify documents it: up to 3 tracks is a single and up
/// to 6 an EP, both only when under 30 minutes. An unknown duration (0)
/// falls back to the track count.
pub fn release_kind(track_count: u32, duration_ms: u64) -> ReleaseKind {
    let short = duration_ms < 30 * 60_000;
    if track_count > 0 && track_count <= 3 && short {
        ReleaseKind::Single
    } else if track_count > 0 && track_count <= 6 && short {
        ReleaseKind::Ep
    } else {
        ReleaseKind::Album
    }
}

fn newest_first(a: &ArtistRelease, b: &ArtistRelease) -> std::cmp::Ordering {
    b.release_year.unwrap_or(0).cmp(&a.release_year.unwrap_or(0))
}

/// `tidalArtistReleases`: newest first (TIDAL returns albums and
/// singles/EPs as two runs).
pub fn tidal_artist_releases(albums: &[SearchAlbum]) -> Vec<ArtistRelease> {
    let mut out: Vec<ArtistRelease> = albums
        .iter()
        .map(|a| ArtistRelease {
            id: a.album.id.clone(),
            title: a.album.title.clone(),
            track_count: a.album.track_count,
            release_year: a.album.release_year.filter(|y| *y != 0),
            has_cover: Some(a.album.has_cover),
            cover_url: a.cover_url.clone(),
            // The artist endpoint only lists TIDAL releases.
            source: Some(TrackSource::Tidal),
            source_id: a.source_id.clone(),
            kind: Some(release_kind(a.album.track_count, a.album.duration_ms)),
            version: a.version.clone(),
            explicit: a.explicit,
            dolby_atmos: a.dolby_atmos,
            versions: None,
        })
        .collect();
    out.sort_by(newest_first);
    out
}

/// Which version a folded tile opens: stereo before Dolby Atmos, then
/// explicit before clean, then TIDAL's order.
fn version_rank(r: &ArtistRelease) -> u8 {
    (if r.dolby_atmos == Some(true) { 2 } else { 0 }) + (if r.explicit == Some(true) { 0 } else { 1 })
}

/// What a release's versions share.
fn release_key(r: &ArtistRelease) -> String {
    format!(
        "{}\n{}\n{}\n{}",
        r.kind == Some(ReleaseKind::Single),
        r.title.trim().to_lowercase(),
        r.version.as_deref().map(|v| v.trim().to_lowercase()).unwrap_or_default(),
        r.release_year.map(|y| y.to_string()).unwrap_or_default()
    )
}

/// What TIDAL's duplicate copies of one version share.
fn copy_key(r: &ArtistRelease) -> String {
    format!(
        "{}\n{}\n{}\n{}",
        release_key(r),
        r.explicit == Some(true),
        r.dolby_atmos == Some(true),
        r.track_count
    )
}

/// `foldReleaseVersions`: one tile per release. Versions share the title,
/// TIDAL's version name and the release year; a single stays apart from an
/// album of the same name, an album and an EP don't. Exact duplicates (the
/// same flags and track count) keep only the first. A folded tile is its
/// preferred version, with `versions` listing them all.
pub fn fold_release_versions(releases: &[ArtistRelease]) -> Vec<ArtistRelease> {
    let mut groups: Vec<(String, Vec<ArtistRelease>)> = Vec::new();
    let mut copies = std::collections::HashSet::new();
    for r in releases {
        if !copies.insert(copy_key(r)) {
            continue;
        }
        let key = release_key(r);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, g)) => g.push(r.clone()),
            None => groups.push((key, vec![r.clone()])),
        }
    }
    let mut out: Vec<ArtistRelease> = groups
        .into_iter()
        .map(|(_, group)| {
            if group.len() == 1 {
                return group.into_iter().next().unwrap();
            }
            let mut versions = group;
            versions.sort_by_key(version_rank);
            ArtistRelease { versions: Some(versions.clone()), ..versions[0].clone() }
        })
        .collect();
    out.sort_by(newest_first);
    out
}

/// `releaseVersionsOf`: the versions of the TIDAL album `source_id` among
/// an artist's releases, if it has others. A duplicate copy the fold
/// dropped stands in for the copy kept, so its page can switch too.
pub fn release_versions_of(releases: &[ArtistRelease], source_id: &str) -> Option<Vec<ArtistRelease>> {
    let album = releases.iter().find(|r| r.source_id.as_deref() == Some(source_id))?;
    let key = release_key(album);
    let folded = fold_release_versions(releases);
    let versions = folded.into_iter().find(|r| release_key(r) == key)?.versions?;
    let own = copy_key(album);
    Some(versions.into_iter().map(|v| if copy_key(&v) == own { album.clone() } else { v }).collect())
}

/// Names for one version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseVersionLabel {
    /// Short, for a segmented control: only what differs between versions.
    pub label: String,
    /// Everything, for a tooltip: "Dolby Atmos · Explicit · 7 tracks · 2026".
    pub description: String,
}

/// `releaseVersionLabels`: Dolby Atmos versions say so; stereo ones are
/// "Explicit" or "Clean" when that differs between them, and otherwise
/// "Stereo" beside an Atmos version. Versions still alike add their track
/// count.
pub fn release_version_labels(versions: &[ArtistRelease]) -> Vec<ReleaseVersionLabel> {
    let explicit = |v: &ArtistRelease| v.explicit == Some(true);
    let atmos_of = |v: &ArtistRelease| v.dolby_atmos == Some(true);
    let mixed = |group: &[&ArtistRelease]| group.iter().any(|v| explicit(v)) && group.iter().any(|v| !explicit(v));
    let content = |v: &ArtistRelease| if explicit(v) { "Explicit" } else { "Clean" };
    let atmos: Vec<&ArtistRelease> = versions.iter().filter(|v| atmos_of(v)).collect();
    let stereo: Vec<&ArtistRelease> = versions.iter().filter(|v| !atmos_of(v)).collect();
    let mut labels: Vec<String> = versions
        .iter()
        .map(|v| {
            if atmos_of(v) {
                if mixed(&atmos) { format!("Dolby Atmos · {}", content(v)) } else { "Dolby Atmos".into() }
            } else if mixed(&stereo) {
                content(v).into()
            } else if !atmos.is_empty() {
                "Stereo".into()
            } else {
                String::new()
            }
        })
        .collect();
    let alike: Vec<String> =
        labels.iter().enumerate().filter(|(i, l)| labels.iter().position(|x| x == *l) != Some(*i)).map(|(_, l)| l.clone()).collect();
    for (i, label) in labels.iter_mut().enumerate() {
        if alike.contains(label) {
            let count = pluralize(versions[i].track_count as u64, "track");
            *label = if label.is_empty() { count } else { format!("{label} · {count}") };
        }
    }
    let any_explicit = versions.iter().any(explicit);
    versions
        .iter()
        .zip(labels)
        .map(|(v, label)| {
            let mut parts = vec![if atmos_of(v) { "Dolby Atmos".to_string() } else { "Stereo".to_string() }];
            if any_explicit {
                parts.push(content(v).into());
            }
            parts.push(pluralize(v.track_count as u64, "track"));
            if let Some(y) = v.release_year.filter(|y| *y != 0) {
                parts.push(y.to_string());
            }
            ReleaseVersionLabel { label, description: parts.join(" · ") }
        })
        .collect()
}

/// `libraryArtistReleases`: library albums in the order the artist's
/// tracks list them.
pub fn library_artist_releases(tracks: &[TrackListItem]) -> Vec<ArtistRelease> {
    let mut out: Vec<ArtistRelease> = Vec::new();
    for t in tracks {
        let (Some(id), Some(title)) = (t.album_id.as_deref(), t.album_title.as_deref()) else { continue };
        if id.is_empty() || title.is_empty() {
            continue;
        }
        match out.iter_mut().find(|r| r.id == id) {
            Some(r) => r.track_count += 1,
            None => out.push(ArtistRelease {
                id: id.to_string(),
                title: title.to_string(),
                track_count: 1,
                has_cover: t.has_cover,
                cover_url: t.cover_url.clone(),
                ..Default::default()
            }),
        }
    }
    out
}

/// Whether the albums / singles-and-EPs split is worth offering.
pub fn has_release_filters(releases: &[ArtistRelease]) -> bool {
    releases.iter().any(|r| r.kind == Some(ReleaseKind::Album))
        && releases.iter().any(|r| matches!(r.kind, Some(ReleaseKind::Ep | ReleaseKind::Single)))
}

/// Releases for a filter; everything when the split isn't available (a
/// refresh can drop one of the kinds).
pub fn filter_releases(releases: &[ArtistRelease], filter: ReleaseFilter) -> Vec<&ArtistRelease> {
    let all = filter == ReleaseFilter::All || !has_release_filters(releases);
    releases
        .iter()
        .filter(|r| match filter {
            _ if all => true,
            ReleaseFilter::Albums => r.kind == Some(ReleaseKind::Album),
            _ => matches!(r.kind, Some(ReleaseKind::Ep | ReleaseKind::Single)),
        })
        .collect()
}

/// "2024 · Single", or "12 tracks" for library albums with no year or
/// kind; a folded release adds "3 versions".
pub fn release_subtitle(r: &ArtistRelease) -> String {
    let mut parts = Vec::new();
    if let Some(y) = r.release_year.filter(|y| *y != 0) {
        parts.push(y.to_string());
    }
    parts.push(r.kind.map_or_else(|| pluralize(r.track_count as u64, "track"), |k| k.label().to_string()));
    if let Some(v) = &r.versions {
        parts.push(pluralize(v.len() as u64, "version"));
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Album;

    const MIN: u64 = 60_000;

    fn album(id: &str, f: impl FnOnce(&mut SearchAlbum)) -> SearchAlbum {
        let mut a = SearchAlbum {
            album: Album {
                id: id.into(),
                title: id.into(),
                track_count: 10,
                duration_ms: 40 * MIN,
                has_cover: true,
                ..Default::default()
            },
            source: TrackSource::Tidal,
            ..Default::default()
        };
        f(&mut a);
        a
    }

    fn roads(id: &str, f: impl FnOnce(&mut SearchAlbum)) -> SearchAlbum {
        album(id, |a| {
            a.album.title = "ALL ROADS LEAD HOME".into();
            a.source_id = Some(id.into());
            a.album.release_year = Some(2026);
            a.explicit = Some(true);
            f(a);
        })
    }

    fn ids(r: &[ArtistRelease]) -> Vec<&str> {
        r.iter().map(|r| r.id.as_str()).collect()
    }

    fn versions(r: &ArtistRelease) -> Option<Vec<&str>> {
        r.versions.as_ref().map(|v| ids(v))
    }

    #[test]
    fn classifies_by_count_and_runtime() {
        assert_eq!(release_kind(1, 3 * MIN), ReleaseKind::Single);
        assert_eq!(release_kind(3, 29 * MIN), ReleaseKind::Single);
        assert_eq!(release_kind(3, 31 * MIN), ReleaseKind::Album);
        assert_eq!(release_kind(6, 20 * MIN), ReleaseKind::Ep);
        assert_eq!(release_kind(6, 30 * MIN), ReleaseKind::Album);
        assert_eq!(release_kind(7, 20 * MIN), ReleaseKind::Album);
        assert_eq!(release_kind(2, 0), ReleaseKind::Single);
        assert_eq!(release_kind(0, 0), ReleaseKind::Album);
    }

    #[test]
    fn orders_newest_first_keeping_same_year_order() {
        let r = tidal_artist_releases(&[
            album("old-album", |a| a.album.release_year = Some(2020)),
            album("new-album", |a| a.album.release_year = Some(2024)),
            album("undated", |a| a.album.release_year = None),
            album("new-single", |a| {
                a.album.release_year = Some(2024);
                a.album.track_count = 1;
                a.album.duration_ms = 3 * MIN;
                a.cover_url = Some("/c".into());
            }),
        ]);
        assert_eq!(ids(&r), ["new-album", "new-single", "old-album", "undated"]);
        assert_eq!((r[1].kind, r[1].cover_url.as_deref(), r[1].release_year), (Some(ReleaseKind::Single), Some("/c"), Some(2024)));
        assert_eq!(release_subtitle(&r[1]), "2024 · Single");
        assert_eq!(release_subtitle(&r[3]), "Album");
    }

    #[test]
    fn filters_only_when_both_kinds_exist() {
        let r = tidal_artist_releases(&[
            album("lp", |_| {}),
            album("ep", |a| {
                a.album.track_count = 5;
                a.album.duration_ms = 18 * MIN;
            }),
            album("single", |a| {
                a.album.track_count = 1;
                a.album.duration_ms = 3 * MIN;
            }),
        ]);
        let filtered = |r: &[ArtistRelease], f| filter_releases(r, f).into_iter().cloned().collect::<Vec<_>>();
        assert!(has_release_filters(&r));
        assert_eq!(ids(&filtered(&r, ReleaseFilter::Albums)), ["lp"]);
        assert_eq!(ids(&filtered(&r, ReleaseFilter::Singles)), ["ep", "single"]);
        assert_eq!(filtered(&r, ReleaseFilter::All), r);
        assert!(!has_release_filters(&filtered(&r, ReleaseFilter::Albums)));
        let albums_only = tidal_artist_releases(&[album("lp", |_| {}), album("lp2", |_| {})]);
        assert_eq!(filtered(&albums_only, ReleaseFilter::Singles), albums_only);
        assert_eq!(filtered(&albums_only, ReleaseFilter::Albums), albums_only);
    }

    #[test]
    fn groups_library_tracks_into_albums() {
        let track = |id: &str, album: Option<(&str, &str)>| TrackListItem {
            id: id.into(),
            title: id.into(),
            duration_ms: 1000,
            album_id: album.map(|a| a.0.into()),
            album_title: album.map(|a| a.1.into()),
            has_cover: Some(true),
            ..Default::default()
        };
        let r = library_artist_releases(&[
            track("1", Some(("b", "Second"))),
            track("2", Some(("a", "First"))),
            track("3", Some(("b", "Second"))),
            track("4", None),
        ]);
        let want = |id: &str, title: &str, n: u32| ArtistRelease {
            id: id.into(),
            title: title.into(),
            track_count: n,
            has_cover: Some(true),
            ..Default::default()
        };
        assert_eq!(r, [want("b", "Second", 2), want("a", "First", 1)]);
        assert!(!has_release_filters(&r));
        assert_eq!(release_subtitle(&r[0]), "2 tracks");
    }

    #[test]
    fn folds_versions_into_a_stereo_explicit_tile() {
        let r = fold_release_versions(&tidal_artist_releases(&[
            roads("atmos", |a| a.dolby_atmos = Some(true)),
            roads("clean", |a| a.explicit = Some(false)),
            roads("explicit", |_| {}),
            album("other", |a| a.album.release_year = Some(2025)),
            roads("deluxe", |a| a.version = Some("Deluxe".into())),
            roads("single", |a| {
                a.album.track_count = 1;
                a.album.duration_ms = 3 * MIN;
            }),
        ]));
        assert_eq!(ids(&r), ["explicit", "deluxe", "single", "other"]);
        assert_eq!(versions(&r[0]), Some(vec!["explicit", "clean", "atmos"]));
        assert_eq!(versions(&r[1]), None);
        assert_eq!(release_subtitle(&r[0]), "2026 · Album · 3 versions");
        assert_eq!(release_subtitle(&r[1]), "2026 · Album");
    }

    #[test]
    fn keeps_years_apart_and_folds_a_clean_ep() {
        let r = fold_release_versions(&tidal_artist_releases(&[
            album("weezer-1994", |a| {
                a.album.title = "Weezer".into();
                a.album.release_year = Some(1994);
            }),
            album("weezer-2001", |a| {
                a.album.title = "Weezer".into();
                a.album.release_year = Some(2001);
            }),
            roads("explicit", |a| {
                a.album.track_count = 7;
                a.album.duration_ms = 28 * MIN;
            }),
            roads("clean", |a| {
                a.explicit = Some(false);
                a.album.track_count = 6;
                a.album.duration_ms = 24 * MIN;
            }),
        ]));
        let got: Vec<(&str, Option<Vec<&str>>)> = r.iter().map(|r| (r.id.as_str(), versions(r))).collect();
        assert_eq!(
            got,
            [("explicit", Some(vec!["explicit", "clean"])), ("weezer-2001", None), ("weezer-1994", None)]
        );
        assert_eq!(r[0].kind, Some(ReleaseKind::Album));
    }

    #[test]
    fn drops_exact_duplicate_copies() {
        let r = fold_release_versions(&tidal_artist_releases(&[
            album("rumours", |a| {
                a.album.title = "Rumours".into();
                a.album.release_year = Some(1977);
            }),
            album("rumours-again", |a| {
                a.album.title = "Rumours".into();
                a.album.release_year = Some(1977);
            }),
            roads("explicit", |_| {}),
            roads("explicit-again", |_| {}),
            roads("clean", |a| a.explicit = Some(false)),
            roads("clean-again", |a| a.explicit = Some(false)),
            roads("explicit-longer", |a| a.album.track_count = 12),
        ]));
        let got: Vec<(&str, Option<Vec<&str>>)> = r.iter().map(|r| (r.id.as_str(), versions(r))).collect();
        assert_eq!(got, [("explicit", Some(vec!["explicit", "explicit-longer", "clean"])), ("rumours", None)]);
        let labels: Vec<String> = release_version_labels(r[0].versions.as_ref().unwrap()).into_iter().map(|l| l.label).collect();
        assert_eq!(labels, ["Explicit · 10 tracks", "Explicit · 12 tracks", "Clean"]);
    }

    #[test]
    fn finds_an_albums_versions() {
        let r = tidal_artist_releases(&[
            roads("explicit", |_| {}),
            roads("clean", |a| a.explicit = Some(false)),
            album("other", |a| a.source_id = Some("other".into())),
        ]);
        assert_eq!(release_versions_of(&r, "clean").map(|v| v.into_iter().map(|r| r.id).collect::<Vec<_>>()), Some(vec!["explicit".into(), "clean".into()]));
        assert_eq!(release_versions_of(&r, "other"), None);
        assert_eq!(release_versions_of(&r, "missing"), None);
    }

    #[test]
    fn a_dropped_duplicate_switches_in_place_of_the_kept_copy() {
        let r = tidal_artist_releases(&[
            roads("explicit", |_| {}),
            roads("explicit-again", |_| {}),
            roads("clean", |a| a.explicit = Some(false)),
        ]);
        let of = |id: &str| release_versions_of(&r, id).map(|v| v.into_iter().map(|r| r.id).collect::<Vec<_>>());
        assert_eq!(of("explicit-again"), Some(vec!["explicit-again".into(), "clean".into()]));
        assert_eq!(of("clean"), Some(vec!["explicit".into(), "clean".into()]));
    }

    #[test]
    fn names_versions_by_what_differs() {
        let labels = |albums: Vec<SearchAlbum>| {
            let folded = fold_release_versions(&tidal_artist_releases(&albums));
            release_version_labels(folded[0].versions.as_deref().unwrap_or(&[]))
        };
        let l = |label: &str, description: &str| ReleaseVersionLabel { label: label.into(), description: description.into() };
        assert_eq!(
            labels(vec![roads("e", |_| {}), roads("c", |a| a.explicit = Some(false)), roads("a", |a| a.dolby_atmos = Some(true))]),
            [
                l("Explicit", "Stereo · Explicit · 10 tracks · 2026"),
                l("Clean", "Stereo · Clean · 10 tracks · 2026"),
                l("Dolby Atmos", "Dolby Atmos · Explicit · 10 tracks · 2026"),
            ]
        );
        assert_eq!(
            labels(vec![
                roads("s", |a| a.explicit = Some(false)),
                roads("a", |a| {
                    a.explicit = Some(false);
                    a.dolby_atmos = Some(true);
                }),
            ]),
            [l("Stereo", "Stereo · 10 tracks · 2026"), l("Dolby Atmos", "Dolby Atmos · 10 tracks · 2026")]
        );
        let just = |v: Vec<ReleaseVersionLabel>| v.into_iter().map(|l| l.label).collect::<Vec<_>>();
        assert_eq!(
            just(labels(vec![
                roads("a1", |a| a.dolby_atmos = Some(true)),
                roads("a2", |a| {
                    a.dolby_atmos = Some(true);
                    a.explicit = Some(false);
                }),
                roads("s", |_| {}),
            ])),
            ["Stereo", "Dolby Atmos · Explicit", "Dolby Atmos · Clean"]
        );
        assert_eq!(
            just(labels(vec![roads("x", |_| {}), roads("y", |a| a.album.track_count = 12)])),
            ["10 tracks", "12 tracks"]
        );
    }

    #[test]
    fn filter_options() {
        assert_eq!(
            RELEASE_FILTER_OPTIONS,
            [(ReleaseFilter::All, "All"), (ReleaseFilter::Albums, "Albums"), (ReleaseFilter::Singles, "Singles & EPs")]
        );
    }
}
