//! Search (`api.search`, `searchPage`, `searchTracks`) and paging helpers
//! (`nextPageParam`, `mergeSearchWarnings`).
//!
//! Search pages by stream: each source (`local`, `tidal`) and kind
//! (`local_album`, `tidal_artist`, …) continues from its own offset. A
//! continuation sends `streams=` with the streams still open; an empty
//! value says every stream is exhausted.

use serde::{Deserialize, Serialize};

use super::client::{ApiResult, Client, query, seg};
use super::types::{
    Page, PageParams, SearchAlbum, SearchArtist, SearchOffsets, SearchResponse, TrackListItem, TrackSource,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SearchType {
    #[default]
    All,
    Track,
    Album,
    Artist,
}

impl SearchType {
    pub fn as_str(self) -> &'static str {
        match self {
            SearchType::All => "all",
            SearchType::Track => "track",
            SearchType::Album => "album",
            SearchType::Artist => "artist",
        }
    }

    /// `isSearchType`: the type a `?type=` value names, if any.
    pub fn parse(value: &str) -> Option<SearchType> {
        SEARCH_TYPE_OPTIONS.iter().find(|(t, _)| t.as_str() == value).map(|(t, _)| *t)
    }

}

/// `SEARCH_TYPE_OPTIONS`: the type picker, in order.
pub const SEARCH_TYPE_OPTIONS: [(SearchType, &str); 4] = [
    (SearchType::All, "All"),
    (SearchType::Track, "Songs"),
    (SearchType::Album, "Albums"),
    (SearchType::Artist, "Artists"),
];

/// How long typing pauses before a search box fires its query.
pub const SEARCH_DEBOUNCE_MS: u64 = 250;

/// `mergeSearchWarnings`: the warnings already shown plus the new page's,
/// each once, empty ones dropped.
pub fn merge_search_warnings(previous: &[String], next: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in previous.iter().chain(next) {
        if !w.is_empty() && !out.contains(w) {
            out.push(w.clone());
        }
    }
    out
}

/// `SearchParams`.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct SearchParams {
    pub page: PageParams,
    /// Defaults to all.
    pub kind: Option<SearchType>,
    pub sources: Option<Vec<TrackSource>>,
}

/// One row of a mixed search page.
#[derive(Clone, Debug, PartialEq)]
pub enum SearchResult {
    Track(TrackListItem),
    Album(SearchAlbum),
    Artist(SearchArtist),
}

/// `searchEntityID`: a TIDAL result's TIDAL id (from `source_id`, or the
/// `tidal:` prefix older payloads carry), else the library id.
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

/// The request path `api.search` sends.
pub fn search_path(params: &SearchParams) -> String {
    let p = &params.page;
    let mut pairs: Vec<(String, Option<String>)> = vec![
        ("limit".into(), p.limit.map(|v| v.to_string())),
        ("offset".into(), p.offset.map(|v| v.to_string())),
        ("q".into(), p.q.clone()),
        ("type".into(), Some(params.kind.unwrap_or_default().as_str().to_string())),
        (
            "sources".into(),
            params.sources.as_ref().map(|s| s.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(",")),
        ),
    ];
    for (key, value) in p.search_offsets.iter().flatten() {
        pairs.push((format!("{key}_offset"), Some(value.to_string())));
    }
    let borrowed: Vec<(&str, Option<String>)> = pairs.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
    let mut path = format!("/api/search{}", query(&borrowed));
    if let Some(offsets) = &p.search_offsets {
        let streams = offsets.keys().map(String::as_str).collect::<Vec<_>>().join(",");
        path.push(if path.contains('?') { '&' } else { '?' });
        path.push_str(&format!("streams={}", seg(&streams)));
    }
    path
}

/// `api.search`.
pub fn search(c: &Client, params: &SearchParams) -> ApiResult<SearchResponse> {
    c.get(&search_path(params))
}

/// `api.searchPage`: artists, then albums, then tracks, as one list; at
/// most 50 per page (25 unless asked).
pub fn search_page(c: &Client, params: &SearchParams) -> ApiResult<Page<SearchResult>> {
    let mut params = params.clone();
    params.page.limit = Some(params.page.limit.unwrap_or(25).min(50));
    let result = search(c, &params)?;
    Ok(search_response_page(result, params.page.offset.unwrap_or(0)))
}

/// A search response as one page, `offset` being where it starts.
pub fn search_response_page(result: SearchResponse, offset: u64) -> Page<SearchResult> {
    let items: Vec<SearchResult> = result
        .artists
        .into_iter()
        .map(SearchResult::Artist)
        .chain(result.albums.into_iter().map(SearchResult::Album))
        .chain(result.tracks.into_iter().map(SearchResult::Track))
        .collect();
    let total = offset + items.len() as u64;
    Page { items, total, next_offsets: Some(result.next_offsets.unwrap_or_default()), warnings: result.warnings }
}

/// The parameters `api.searchTracks` sends: songs only, and a continuation
/// keeps only the track streams (`local`, `tidal`), which also become the
/// sources searched.
pub fn search_tracks_params(params: &SearchParams) -> SearchParams {
    let mut out = params.clone();
    out.kind = Some(SearchType::Track);
    if let Some(offsets) = &params.page.search_offsets {
        let kept: SearchOffsets =
            offsets.iter().filter(|(k, _)| *k == "local" || *k == "tidal").map(|(k, v)| (k.clone(), *v)).collect();
        out.sources = Some(
            kept.keys()
                .map(|k| if k == "tidal" { TrackSource::Tidal } else { TrackSource::Local })
                .collect(),
        );
        out.page.search_offsets = Some(kept);
    }
    out
}

/// `api.searchTracks`: for song-only callers (playlist pickers).
pub fn search_tracks(c: &Client, params: &SearchParams) -> ApiResult<SearchResponse> {
    search(c, &search_tracks_params(params))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::testing::{MockServer, Res};

    fn offsets(pairs: &[(&str, u64)]) -> SearchOffsets {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    fn q(path: &str) -> url::Url {
        url::Url::parse(&format!("https://example.test{path}")).unwrap()
    }

    fn param(url: &url::Url, key: &str) -> Option<String> {
        url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
    }

    // search.test.ts
    #[test]
    fn uses_local_ids_for_local_routes_and_strips_remote_prefixes() {
        assert_eq!(search_entity_id("local-id", Some(TrackSource::Local), Some("upstream-id")), "local-id");
        assert_eq!(search_entity_id("tidal:42", Some(TrackSource::Tidal), None), "42");
        assert_eq!(search_entity_id("tidal:42", Some(TrackSource::Tidal), Some("43")), "43");
    }

    #[test]
    fn keeps_mixed_cursors_out_of_song_only_continuations() {
        let params = SearchParams {
            page: PageParams {
                q: Some("hello".into()),
                search_offsets: Some(offsets(&[("tidal", 25), ("local_album", 50), ("tidal_artist", 75)])),
                ..Default::default()
            },
            ..Default::default()
        };
        let url = q(&search_path(&search_tracks_params(&params)));
        assert_eq!(param(&url, "sources").as_deref(), Some("tidal"));
        assert_eq!(param(&url, "streams").as_deref(), Some("tidal"));
        assert_eq!(param(&url, "tidal_offset").as_deref(), Some("25"));
        assert_eq!(param(&url, "local_album_offset"), None);
        assert_eq!(param(&url, "type").as_deref(), Some("track"));
    }

    #[test]
    fn preserves_entity_types_and_stream_offsets_across_mixed_pages() {
        let server = MockServer::start(vec![
            Res::json(
                r#"{"tracks":[{"id":"tidal:1","title":"t"}],"albums":[{"id":"tidal:1","title":"a","source":"tidal"}],
                "artists":[{"id":"local-artist","name":"n","source":"local"}],"next_offsets":{"tidal":25,"tidal_album":50},
                "warnings":["Artists unavailable"]}"#,
            ),
            Res::json(r#"{"tracks":[],"albums":[{"id":"tidal:2","title":"b","source":"tidal"}],"artists":[],"next_offsets":{}}"#),
        ]);
        let c = server.client();
        let params = SearchParams {
            page: PageParams { q: Some("hello".into()), ..Default::default() },
            kind: Some(SearchType::All),
            ..Default::default()
        };
        let first = search_page(&c, &params).unwrap();
        let kinds: Vec<&str> = first
            .items
            .iter()
            .map(|r| match r {
                SearchResult::Artist(_) => "artist",
                SearchResult::Album(_) => "album",
                SearchResult::Track(_) => "track",
            })
            .collect();
        assert_eq!(kinds, ["artist", "album", "track"]);
        assert_eq!(first.warnings, ["Artists unavailable"]);
        let mut next = params.clone();
        next.page.offset = Some(first.items.len() as u64);
        next.page.search_offsets = first.next_offsets.clone();
        let second = search_page(&c, &next).unwrap();
        let url = q(&server.requests()[1].path);
        assert_eq!(param(&url, "type").as_deref(), Some("all"));
        assert_eq!(param(&url, "streams").as_deref(), Some("tidal,tidal_album"));
        assert_eq!(param(&url, "tidal_offset").as_deref(), Some("25"));
        assert_eq!(param(&url, "tidal_album_offset").as_deref(), Some("50"));
        assert_eq!(param(&url, "local_offset"), None);
        assert_eq!(second.next_offsets, Some(SearchOffsets::new()));
        assert_eq!(second.total, 4);
    }

    #[test]
    fn sends_an_explicit_empty_continuation() {
        let params = SearchParams {
            page: PageParams { q: Some("hello".into()), search_offsets: Some(SearchOffsets::new()), ..Default::default() },
            kind: Some(SearchType::Album),
            ..Default::default()
        };
        let url = q(&search_path(&params));
        assert_eq!(param(&url, "streams").as_deref(), Some(""));
    }

    #[test]
    fn keeps_song_only_consumers_on_track_search() {
        let params = SearchParams { page: PageParams { q: Some("hello".into()), ..Default::default() }, ..Default::default() };
        let url = q(&search_path(&search_tracks_params(&params)));
        assert_eq!(param(&url, "type").as_deref(), Some("track"));
        assert_eq!(param(&url, "streams"), None);
    }

    // api.test.ts: search continuation
    #[test]
    fn continues_only_the_open_source_with_its_own_offset() {
        let params = SearchParams {
            page: PageParams {
                q: Some("song".into()),
                limit: Some(50),
                offset: Some(2),
                search_offsets: Some(offsets(&[("tidal", 50)])),
                ..Default::default()
            },
            ..Default::default()
        };
        let url = q(&search_path(&search_tracks_params(&params)));
        assert_eq!(param(&url, "sources").as_deref(), Some("tidal"));
        assert_eq!(param(&url, "tidal_offset").as_deref(), Some("50"));
        assert_eq!(param(&url, "local_offset"), None);
    }

    #[test]
    fn merges_warnings_once_each() {
        let s = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            merge_search_warnings(&s(&["TIDAL is slow."]), &s(&["TIDAL is slow.", "Local index rebuilding."])),
            s(&["TIDAL is slow.", "Local index rebuilding."])
        );
        assert_eq!(merge_search_warnings(&[], &s(&["", "A"])), s(&["A"]));
        assert!(merge_search_warnings(&[], &[]).is_empty());
        assert_eq!(SEARCH_DEBOUNCE_MS, 250);
    }

    #[test]
    fn search_types_round_trip() {
        assert_eq!(SearchType::parse("track"), Some(SearchType::Track));
        assert_eq!(SearchType::parse("songs"), None);
    }
}
