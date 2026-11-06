//! The pure helpers the Library pages need from `@music-library/core`:
//! `entity-labels.ts` (subtitles, credits, facts), `artist-releases.ts`
//! (discography folding, version labels), `entity-target.ts`, `track.ts`'s
//! `albumDownloadState`, `player/play-list.ts` and `format.ts`'s
//! `pluralize`, plus `ListMeta`'s count line.
//!
//! TODO(api-merge): the core port in `crate::core` replaces these; keep the
//! signatures close so call sites only change their imports.
#![allow(dead_code)]

use crate::api::{Album, SearchAlbum, TrackListItem, TrackSource};
use crate::format::{display_text, fmt_total_ms};

const SEPARATOR: &str = " · ";

fn join_parts(parts: &[Option<String>]) -> String {
    parts.iter().flatten().filter(|p| !p.is_empty()).cloned().collect::<Vec<_>>().join(SEPARATOR)
}

/// `pluralize`: "1 track" / "2 tracks".
pub fn pluralize(n: u64, singular: &str) -> String {
    if n == 1 { format!("{n} {singular}") } else { format!("{n} {singular}s") }
}

/// `n.toLocaleString()` in en-US: "1,234".
pub fn grouped(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `ListMeta`: "30 tracks", "60 of 120 albums", or "—" before the first page.
pub fn list_meta(loaded: Option<usize>, total: Option<u64>, unit: &str) -> String {
    let Some(loaded) = loaded else { return "—".into() };
    let noun = |n: u64| if n == 1 { unit.to_string() } else { format!("{unit}s") };
    match total {
        Some(total) if total > loaded as u64 => format!("{} of {} {}", grouped(loaded as u64), grouped(total), noun(total)),
        Some(total) => format!("{} {}", grouped(total), noun(total)),
        None => format!("{} {}", grouped(loaded as u64), noun(loaded as u64)),
    }
}

// ---------------------------------------------------------------- entity labels

/// `albumArtistName`.
pub fn album_artist_name(artist_name: Option<&str>, is_compilation: bool) -> String {
    let name = display_text(artist_name, "");
    if !name.is_empty() {
        name
    } else if is_compilation {
        "Various Artists".into()
    } else {
        "Unknown artist".into()
    }
}

/// `albumSubtitle`: "Artist · 12 tracks · TIDAL".
pub fn album_subtitle(album: &Album, source: Option<TrackSource>) -> String {
    join_parts(&[
        Some(album_artist_name(album.artist_name.as_deref(), album.is_compilation)),
        Some(pluralize(album.track_count as u64, "track")),
        (source == Some(TrackSource::Tidal)).then(|| "TIDAL".to_string()),
    ])
}

/// `artistMetaParts`: "12 tracks", "3 albums" (or "TIDAL artist" from search).
pub fn artist_meta_parts(track_count: u32, album_count: u32, source: Option<TrackSource>) -> Vec<String> {
    let first =
        if source == Some(TrackSource::Tidal) { "TIDAL artist".to_string() } else { pluralize(track_count as u64, "track") };
    let mut parts = vec![first];
    if album_count > 0 {
        parts.push(pluralize(album_count as u64, "album"));
    }
    parts
}

/// `artistSubtitle`.
pub fn artist_subtitle(track_count: u32, album_count: u32, source: Option<TrackSource>) -> String {
    artist_meta_parts(track_count, album_count, source).join(SEPARATOR)
}

/// `tidalArtistMetaParts`: "8 releases", "10 popular tracks".
pub fn tidal_artist_meta_parts(release_count: usize, popular: usize) -> Vec<String> {
    let mut parts = Vec::new();
    if release_count > 0 {
        parts.push(pluralize(release_count as u64, "release"));
    }
    if popular > 0 {
        parts.push(pluralize(popular as u64, "popular track"));
    }
    parts
}

/// One artist an album page credits under its title.
#[derive(Clone, Debug, PartialEq)]
pub struct AlbumCredit {
    pub name: String,
    /// The library artist page the name opens.
    pub artist_id: Option<String>,
}

/// What `albumCredits` reads off a library or TIDAL album.
#[derive(Default)]
pub struct CreditFields<'a> {
    pub artist_id: Option<&'a str>,
    pub artist_has_page: Option<bool>,
    pub artist_name: Option<&'a str>,
    pub artist_names: &'a [String],
    pub artists: &'a [String],
    pub artist: Option<&'a str>,
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// `albumCredits`: every main artist when known, else the album artist; the
/// album artist links when the server says it has a page.
pub fn album_credits(f: &CreditFields) -> Vec<AlbumCredit> {
    let fallback = [f.artist_name.filter(|s| !s.is_empty()).or(f.artist).unwrap_or("").to_string()];
    let listed: &[String] = if !f.artist_names.is_empty() {
        f.artist_names
    } else if !f.artists.is_empty() {
        f.artists
    } else {
        &fallback
    };
    let mut names: Vec<String> = Vec::new();
    for raw in listed {
        let name = display_text(Some(raw), "");
        if !name.is_empty() && !names.iter().any(|o| same_name(o, &name)) {
            names.push(name);
        }
    }
    let own = display_text(f.artist_name, "");
    let linked = f.artist_id.is_some_and(|s| !s.is_empty()) && f.artist_has_page == Some(true) && !own.is_empty();
    names
        .into_iter()
        .map(|name| {
            let artist_id = (linked && same_name(&name, &own)).then(|| f.artist_id.unwrap_or("").to_string());
            AlbumCredit { name, artist_id }
        })
        .collect()
}

/// `creditsOnly`: whether `artist` (names joined with ", ") credits only
/// names from `names`, matching whole entries without case.
pub fn credits_only(artist: Option<&str>, names: &[String]) -> bool {
    let credit = display_text(artist, "").to_lowercase();
    let mut entries: Vec<String> = Vec::new();
    for n in names {
        let e = display_text(Some(n), "").to_lowercase();
        if !e.is_empty() && !entries.contains(&e) {
            entries.push(e);
        }
    }
    if credit.is_empty() {
        return false;
    }
    let mut starts = std::collections::BTreeSet::from([0usize]);
    let mut at = 0;
    while at < credit.len() {
        if starts.contains(&at) {
            for entry in &entries {
                if !credit[at..].starts_with(entry.as_str()) {
                    continue;
                }
                let end = at + entry.len();
                if end == credit.len() {
                    return true;
                }
                if credit[end..].starts_with(", ") {
                    starts.insert(end + 2);
                }
            }
        }
        at += 1;
        while at < credit.len() && !credit.is_char_boundary(at) {
            at += 1;
        }
    }
    false
}

/// `albumLength`: "12 tracks · 48 min".
pub fn album_length(tracks: &[TrackListItem]) -> String {
    let total: u64 = tracks.iter().map(|t| t.duration_ms).sum();
    join_parts(&[
        Some(pluralize(tracks.len() as u64, "track")),
        (total > 0).then(|| fmt_total_ms(total.max(60_000))),
    ])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FactKey {
    Released,
    Length,
    Saved,
}

/// One fact in an album page's Details.
#[derive(Clone, Debug, PartialEq)]
pub struct AlbumFact {
    pub key: FactKey,
    pub label: &'static str,
    pub value: String,
}

fn album_facts(tracks: &[TrackListItem], saved: Option<u32>, year: Option<i32>) -> Vec<AlbumFact> {
    let mut facts = Vec::new();
    if let Some(y) = year.filter(|y| *y != 0) {
        facts.push(AlbumFact { key: FactKey::Released, label: "Released", value: y.to_string() });
    }
    facts.push(AlbumFact { key: FactKey::Length, label: "Length", value: album_length(tracks) });
    if let Some(s) = saved {
        facts.push(AlbumFact {
            key: FactKey::Saved,
            label: "Saved",
            value: format!("{s} of {}", pluralize(tracks.len() as u64, "track")),
        });
    }
    facts
}

/// `libraryAlbumFacts`.
pub fn library_album_facts(album: &Album, tracks: &[TrackListItem]) -> Vec<AlbumFact> {
    let saved = if album.tidal_album_id.as_deref().is_some_and(|s| !s.is_empty()) { album.saved_count } else { None };
    album_facts(tracks, saved, album.release_year)
}

/// `tidalAlbumFacts`: Saved reads "None" rather than going missing.
pub fn tidal_album_facts(saved_count: Option<u32>, release_year: Option<i32>, tracks: &[TrackListItem]) -> Vec<AlbumFact> {
    let saved = saved_count.filter(|s| *s > 0);
    let mut facts = album_facts(tracks, saved, release_year);
    if saved.is_none() {
        facts.push(AlbumFact { key: FactKey::Saved, label: "Saved", value: "None".into() });
    }
    facts
}

// ---------------------------------------------------------------- entity targets

/// `EntityTarget`: the library's own page, or TIDAL's (`id` without the
/// `tidal:` prefix).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntityTarget {
    Local(String),
    Tidal(String),
}

/// `searchEntityID`.
pub fn search_entity_id(id: &str, source: Option<TrackSource>, source_id: Option<&str>) -> String {
    if source == Some(TrackSource::Tidal) {
        match source_id.filter(|s| !s.is_empty()) {
            Some(s) => s.to_string(),
            None => id.strip_prefix("tidal:").unwrap_or(id).to_string(),
        }
    } else {
        id.to_string()
    }
}

/// `searchEntityTarget`.
pub fn search_entity_target(id: &str, source: Option<TrackSource>, source_id: Option<&str>) -> EntityTarget {
    if source == Some(TrackSource::Tidal) {
        EntityTarget::Tidal(search_entity_id(id, source, source_id))
    } else {
        EntityTarget::Local(id.to_string())
    }
}

// ---------------------------------------------------------------- artist releases

/// Popular tracks an artist page shows before "See more".
pub const ARTIST_POPULAR_PREVIEW_COUNT: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ReleaseFilter {
    #[default]
    All,
    Albums,
    Singles,
}

pub const RELEASE_FILTER_OPTIONS: [(ReleaseFilter, &str); 3] =
    [(ReleaseFilter::All, "All"), (ReleaseFilter::Albums, "Albums"), (ReleaseFilter::Singles, "Singles & EPs")];

/// One tile in an artist's discography.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ArtistRelease {
    pub id: String,
    pub title: String,
    pub track_count: u32,
    pub release_year: Option<i32>,
    pub has_cover: Option<bool>,
    pub cover_url: Option<String>,
    pub source: Option<TrackSource>,
    pub source_id: Option<String>,
    pub kind: Option<ReleaseKind>,
    pub version: Option<String>,
    pub explicit: bool,
    pub dolby_atmos: bool,
    /// Set by [`fold_release_versions`]: all versions, this one first.
    pub versions: Option<Vec<ArtistRelease>>,
}

impl ArtistRelease {
    pub fn target(&self) -> EntityTarget {
        search_entity_target(&self.id, self.source, self.source_id.as_deref())
    }
}

/// `releaseKind`: up to 3 tracks a single, up to 6 an EP, both under 30 min.
pub fn release_kind(track_count: u32, duration_ms: u64) -> ReleaseKind {
    let short = !(duration_ms >= 30 * 60_000);
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

/// `tidalArtistReleases`: newest first.
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
            source: Some(TrackSource::Tidal),
            source_id: a.source_id.clone(),
            kind: Some(release_kind(a.album.track_count, a.album.duration_ms)),
            version: a.version.clone(),
            explicit: a.explicit.unwrap_or(false),
            dolby_atmos: a.dolby_atmos.unwrap_or(false),
            versions: None,
        })
        .collect();
    out.sort_by(newest_first);
    out
}

fn version_rank(r: &ArtistRelease) -> u8 {
    (if r.dolby_atmos { 2 } else { 0 }) + (if r.explicit { 0 } else { 1 })
}

fn release_key(r: &ArtistRelease) -> String {
    format!(
        "{}\n{}\n{}\n{}",
        r.kind == Some(ReleaseKind::Single),
        r.title.trim().to_lowercase(),
        r.version.as_deref().map(|v| v.trim().to_lowercase()).unwrap_or_default(),
        r.release_year.map(|y| y.to_string()).unwrap_or_default()
    )
}

fn copy_key(r: &ArtistRelease) -> String {
    format!("{}\n{}\n{}\n{}", release_key(r), r.explicit, r.dolby_atmos, r.track_count)
}

/// `foldReleaseVersions`: one tile per release, its preferred version.
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

/// `releaseVersionsOf`: the versions of TIDAL album `source_id`, if any.
pub fn release_versions_of(releases: &[ArtistRelease], source_id: &str) -> Option<Vec<ArtistRelease>> {
    let album = releases.iter().find(|r| r.source_id.as_deref() == Some(source_id))?;
    let key = release_key(album);
    let versions = fold_release_versions(releases).into_iter().find(|r| release_key(r) == key)?.versions?;
    let own = copy_key(album);
    Some(versions.into_iter().map(|v| if copy_key(&v) == own { album.clone() } else { v }).collect())
}

/// A version's short label and its tooltip.
#[derive(Clone, Debug, PartialEq)]
pub struct VersionLabel {
    pub label: String,
    pub description: String,
}

/// `releaseVersionLabels`.
pub fn release_version_labels(versions: &[ArtistRelease]) -> Vec<VersionLabel> {
    let mixed = |g: &[&ArtistRelease]| g.iter().any(|v| v.explicit) && g.iter().any(|v| !v.explicit);
    let content = |v: &ArtistRelease| if v.explicit { "Explicit" } else { "Clean" };
    let atmos: Vec<&ArtistRelease> = versions.iter().filter(|v| v.dolby_atmos).collect();
    let stereo: Vec<&ArtistRelease> = versions.iter().filter(|v| !v.dolby_atmos).collect();
    let mut labels: Vec<String> = versions
        .iter()
        .map(|v| {
            if v.dolby_atmos {
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
    let alike: Vec<String> = labels
        .iter()
        .enumerate()
        .filter(|(i, l)| labels.iter().position(|x| x == *l) != Some(*i))
        .map(|(_, l)| l.clone())
        .collect();
    for (i, label) in labels.iter_mut().enumerate() {
        if alike.contains(label) {
            let count = pluralize(versions[i].track_count as u64, "track");
            *label = if label.is_empty() { count } else { format!("{label} · {count}") };
        }
    }
    let any_explicit = versions.iter().any(|v| v.explicit);
    versions
        .iter()
        .zip(labels)
        .map(|(v, label)| {
            let mut parts = vec![if v.dolby_atmos { "Dolby Atmos".to_string() } else { "Stereo".to_string() }];
            if any_explicit {
                parts.push(content(v).into());
            }
            parts.push(pluralize(v.track_count as u64, "track"));
            if let Some(y) = v.release_year.filter(|y| *y != 0) {
                parts.push(y.to_string());
            }
            VersionLabel { label, description: parts.join(SEPARATOR) }
        })
        .collect()
}

/// `libraryArtistReleases`: albums in the order the tracks list them.
pub fn library_artist_releases(tracks: &[TrackListItem]) -> Vec<ArtistRelease> {
    let mut out: Vec<ArtistRelease> = Vec::new();
    for t in tracks {
        let (Some(album_id), Some(title)) = (t.album_id.as_deref(), t.album_title.as_deref()) else { continue };
        if album_id.is_empty() || title.is_empty() {
            continue;
        }
        if let Some(r) = out.iter_mut().find(|r| r.id == album_id) {
            r.track_count += 1;
        } else {
            out.push(ArtistRelease {
                id: album_id.to_string(),
                title: title.to_string(),
                track_count: 1,
                has_cover: t.has_cover,
                cover_url: t.cover_url.clone(),
                ..Default::default()
            });
        }
    }
    out
}

/// `hasReleaseFilters`.
pub fn has_release_filters(releases: &[ArtistRelease]) -> bool {
    releases.iter().any(|r| r.kind == Some(ReleaseKind::Album))
        && releases.iter().any(|r| matches!(r.kind, Some(ReleaseKind::Ep | ReleaseKind::Single)))
}

/// `filterReleases`.
pub fn filter_releases(releases: &[ArtistRelease], filter: ReleaseFilter) -> Vec<ArtistRelease> {
    if filter == ReleaseFilter::All || !has_release_filters(releases) {
        return releases.to_vec();
    }
    releases
        .iter()
        .filter(|r| match filter {
            ReleaseFilter::Albums => r.kind == Some(ReleaseKind::Album),
            _ => matches!(r.kind, Some(ReleaseKind::Ep | ReleaseKind::Single)),
        })
        .cloned()
        .collect()
}

/// `releaseSubtitle`: "2024 · Single", "12 tracks", "… · 3 versions".
pub fn release_subtitle(r: &ArtistRelease) -> String {
    let mut parts = Vec::new();
    if let Some(y) = r.release_year.filter(|y| *y != 0) {
        parts.push(y.to_string());
    }
    parts.push(match r.kind {
        Some(k) => k.label().to_string(),
        None => pluralize(r.track_count as u64, "track"),
    });
    if let Some(v) = &r.versions {
        parts.push(pluralize(v.len() as u64, "version"));
    }
    parts.join(SEPARATOR)
}

// ---------------------------------------------------------------- downloads

/// How often album pages refetch while tracks are queued for download.
pub const ALBUM_DOWNLOAD_REFRESH_MS: u64 = 15_000;

#[derive(Clone, Debug, PartialEq)]
pub enum AlbumDownloadState {
    Queued { label: String },
    Available { label: String },
    None,
}

fn is_tidal(t: &TrackListItem) -> bool {
    t.source == Some(TrackSource::Tidal)
}

/// `albumDownloadState`.
pub fn album_download_state(tracks: &[TrackListItem], queued: u32) -> AlbumDownloadState {
    if queued > 0 {
        return AlbumDownloadState::Queued { label: format!("Downloading · {queued} left") };
    }
    let remaining = tracks.iter().filter(|t| is_tidal(t) && t.unavailable != Some(true)).count();
    if remaining == 0 {
        return AlbumDownloadState::None;
    }
    let any_saved = tracks.iter().any(|t| !is_tidal(t));
    AlbumDownloadState::Available {
        label: if any_saved { format!("Download {remaining} remaining") } else { "Download album".into() },
    }
}

// ---------------------------------------------------------------- playback

/// `listPlaybackState`: (playing here, show pause, can play).
pub fn list_playback_state(tracks: &[TrackListItem], current: Option<&TrackListItem>, playing: bool) -> (bool, bool, bool) {
    let here = current.is_some_and(|c| tracks.iter().any(|t| t.id == c.id));
    (here, here && playing, tracks.iter().any(|t| t.unavailable != Some(true)))
}

/// A random index below `n` (Math.random's role).
fn random_below(n: usize) -> usize {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    (h.finish() % n.max(1) as u64) as usize
}

/// `startListPlayback`: the list's playable tracks from the first, or from a
/// random one when shuffle is on. False when nothing can play.
pub fn start_list_playback(player: &mut crate::player::Player, tracks: &[TrackListItem]) -> bool {
    let queue: Vec<TrackListItem> = tracks.iter().filter(|t| t.unavailable != Some(true)).cloned().collect();
    if queue.is_empty() {
        return false;
    }
    let start = if player.shuffle { random_below(queue.len()) } else { 0 };
    player.play_list(queue, start);
    true
}

/// `usePlayFromList`'s `playTrack`: `track` with the list's playable tracks as the queue.
pub fn play_from_list(player: &mut crate::player::Player, tracks: &[TrackListItem], id: &str) {
    let queue: Vec<TrackListItem> = tracks.iter().filter(|t| t.unavailable != Some(true)).cloned().collect();
    if let Some(i) = queue.iter().position(|t| t.id == id) {
        player.play_list(queue, i);
    }
}

// ---------------------------------------------------------------- search

/// `mergeSearchWarnings`: the shown warnings plus the new page's, each once.
pub fn merge_search_warnings(previous: &[String], next: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in previous.iter().chain(next) {
        if !w.is_empty() && !out.contains(w) {
            out.push(w.clone());
        }
    }
    out
}

/// `trackSearchKey`: what an album or artist page's search matches.
pub fn track_search_key(t: &TrackListItem) -> String {
    let source = t.source.map(|s| match s {
        TrackSource::Local => "local",
        TrackSource::Tidal => "tidal",
    });
    [Some(t.title.as_str()), t.artist.as_deref(), t.album_title.as_deref(), t.aka.as_deref(), source]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// `artistImageUrl`: the artist's own picture, else its first track's cover.
pub fn artist_image_url(cover_url: Option<&str>, tracks: &[TrackListItem], size: Option<u32>) -> Option<String> {
    if let Some(u) = cover_url.filter(|u| !u.is_empty()) {
        return Some(crate::api::media::resolve_cover(u, size));
    }
    let t = tracks.iter().find(|t| t.has_cover != Some(false))?;
    Some(crate::api::media::track_cover(&t.id, t.album_id.as_deref(), t.cover_url.as_deref(), size))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(id: &str, title: &str, year: i32, tracks: u32, explicit: bool, atmos: bool) -> ArtistRelease {
        ArtistRelease {
            id: format!("tidal:{id}"),
            title: title.into(),
            track_count: tracks,
            release_year: Some(year),
            source: Some(TrackSource::Tidal),
            source_id: Some(id.into()),
            kind: Some(release_kind(tracks, 1_000_000)),
            explicit,
            dolby_atmos: atmos,
            ..Default::default()
        }
    }

    #[test]
    fn counts_and_meta() {
        assert_eq!(pluralize(1, "track"), "1 track");
        assert_eq!(pluralize(3, "album"), "3 albums");
        assert_eq!(grouped(1234567), "1,234,567");
        assert_eq!(list_meta(None, None, "track"), "—");
        assert_eq!(list_meta(Some(30), Some(30), "track"), "30 tracks");
        assert_eq!(list_meta(Some(60), Some(1200), "album"), "60 of 1,200 albums");
        assert_eq!(list_meta(Some(1), Some(1), "artist"), "1 artist");
    }

    #[test]
    fn folds_versions_and_labels_them() {
        let releases = vec![
            rel("3", "Live", 2023, 4, true, true),
            rel("1", "Live", 2023, 4, true, false),
            rel("2", "Live", 2023, 4, false, false),
            rel("9", "Paper Coast", 2021, 11, false, false),
        ];
        let folded = fold_release_versions(&releases);
        assert_eq!(folded.len(), 2);
        assert_eq!(folded[0].source_id.as_deref(), Some("1"));
        let versions = release_versions_of(&releases, "2").unwrap();
        let labels: Vec<String> = release_version_labels(&versions).into_iter().map(|l| l.label).collect();
        assert_eq!(labels, ["Explicit", "Clean", "Dolby Atmos"]);
        assert_eq!(release_subtitle(&folded[0]), "2023 · EP · 3 versions");
    }

    #[test]
    fn credits_match_whole_entries() {
        let names = vec!["Earth, Wind & Fire".to_string(), "Kestrel Bay".to_string()];
        assert!(credits_only(Some("Kestrel Bay, Earth, Wind & Fire"), &names));
        assert!(!credits_only(Some("Earth"), &names));
        assert!(!credits_only(Some("Kestrel Bay, Hana Okoro"), &names));
        assert!(!credits_only(None, &names));
    }

    #[test]
    fn download_states() {
        let tidal = TrackListItem { source: Some(TrackSource::Tidal), ..Default::default() };
        let local = TrackListItem { source: Some(TrackSource::Local), ..Default::default() };
        assert_eq!(album_download_state(&[tidal.clone()], 0), AlbumDownloadState::Available { label: "Download album".into() });
        assert_eq!(
            album_download_state(&[local, tidal.clone()], 0),
            AlbumDownloadState::Available { label: "Download 1 remaining".into() }
        );
        assert_eq!(album_download_state(&[tidal], 2), AlbumDownloadState::Queued { label: "Downloading · 2 left".into() });
    }

    #[test]
    fn album_length_rounds_up_to_a_minute() {
        let t = |ms| TrackListItem { duration_ms: ms, ..Default::default() };
        assert_eq!(album_length(&[t(20_000)]), "1 track · 1 min");
        assert_eq!(album_length(&[t(0), t(0)]), "2 tracks");
    }
}
