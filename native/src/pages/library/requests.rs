//! The Library pages' requests (`api.listTracksPage`, `searchPage`,
//! `getAlbum`, `getTidalAlbum`, `getTidalArtist`, the album download, …) as
//! thin blocking calls on [`Client`], and the payloads `crate::api::types`
//! doesn't have yet. Run them on `app.net` workers.
//!
//! TODO(api-merge): `crate::api::<area>` replaces these.
#![allow(dead_code)]

use serde::Deserialize;

use crate::api::{Album, ApiResult, Artist, Client, SearchAlbum, SearchArtist, SearchResponse, TrackListItem, query, seg};

/// `TidalAlbum`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct TidalAlbum {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub artist_id: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub artists: Option<Vec<String>>,
    #[serde(default)]
    pub release_year: Option<i32>,
    #[serde(default)]
    pub saved_count: Option<u32>,
    #[serde(default)]
    pub library_album_id: Option<String>,
    #[serde(default)]
    pub queued_count: Option<u32>,
    #[serde(default)]
    pub track_count: u32,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub tracks: Option<Vec<TrackListItem>>,
}

impl TidalAlbum {
    pub fn tracks(&self) -> &[TrackListItem] {
        self.tracks.as_deref().unwrap_or(&[])
    }
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct TidalArtistProfile {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub cover_url: Option<String>,
}

/// `TidalArtist`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct TidalArtist {
    #[serde(default)]
    pub artist: Option<TidalArtistProfile>,
    #[serde(default)]
    pub albums: Option<Vec<SearchAlbum>>,
    #[serde(default)]
    pub tracks: Option<Vec<TrackListItem>>,
    #[serde(default)]
    pub warnings: Option<Vec<String>>,
}

impl TidalArtist {
    pub fn albums(&self) -> &[SearchAlbum] {
        self.albums.as_deref().unwrap_or(&[])
    }
    pub fn tracks(&self) -> &[TrackListItem] {
        self.tracks.as_deref().unwrap_or(&[])
    }
}

/// `SearchType`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum SearchType {
    All,
    #[default]
    Track,
    Album,
    Artist,
}

impl SearchType {
    pub fn param(self) -> &'static str {
        match self {
            SearchType::All => "all",
            SearchType::Track => "track",
            SearchType::Album => "album",
            SearchType::Artist => "artist",
        }
    }
    /// `isSearchType`.
    pub fn parse(s: &str) -> Option<SearchType> {
        match s {
            "all" => Some(SearchType::All),
            "track" => Some(SearchType::Track),
            "album" => Some(SearchType::Album),
            "artist" => Some(SearchType::Artist),
            _ => None,
        }
    }
}

/// `SEARCH_TYPE_OPTIONS`.
pub const SEARCH_TYPE_OPTIONS: [(SearchType, &str); 4] =
    [(SearchType::All, "All"), (SearchType::Track, "Songs"), (SearchType::Album, "Albums"), (SearchType::Artist, "Artists")];

/// How long typing pauses before a search box fires its query.
pub const SEARCH_DEBOUNCE_MS: u64 = 250;

/// One search hit (`SearchResult`).
#[derive(Clone, Debug, PartialEq)]
pub enum SearchItem {
    Track(TrackListItem),
    Album(SearchAlbum),
    Artist(SearchArtist),
}

/// Per-stream search cursors (`SearchOffsets`); empty means exhausted.
pub type SearchOffsets = serde_json::Map<String, serde_json::Value>;

/// A search page: hits, the cursors for the next page, and its warnings.
pub struct SearchPage {
    pub items: Vec<SearchItem>,
    pub next_offsets: SearchOffsets,
    pub warnings: Vec<String>,
}

fn paged(path: &str, limit: usize, offset: usize, sort: Option<&str>) -> String {
    format!(
        "{path}{}",
        query(&[
            ("limit", Some(limit.to_string())),
            ("offset", Some(offset.to_string())),
            ("sort", sort.map(str::to_string)),
        ])
    )
}

/// `api.listTracksPage`.
pub fn list_tracks_page(c: &Client, limit: usize, offset: usize, sort: &str) -> ApiResult<(Vec<TrackListItem>, u64)> {
    c.page(&paged("/api/tracks", limit, offset, Some(sort)))
}

/// `api.listAlbumsPage`.
pub fn list_albums_page(c: &Client, limit: usize, offset: usize) -> ApiResult<(Vec<Album>, u64)> {
    c.page(&paged("/api/albums", limit, offset, None))
}

/// `api.listArtistsPage`.
pub fn list_artists_page(c: &Client, limit: usize, offset: usize) -> ApiResult<(Vec<Artist>, u64)> {
    c.page(&paged("/api/artists", limit, offset, None))
}

/// `api.searchPage`: one page of a search, artists then albums then tracks.
/// `offsets` are the previous page's cursors (None for a first page).
pub fn search_page(
    c: &Client,
    q: &str,
    kind: SearchType,
    limit: usize,
    offset: usize,
    offsets: Option<&SearchOffsets>,
) -> ApiResult<SearchPage> {
    let mut params: Vec<(String, Option<String>)> = vec![
        ("limit".into(), Some(limit.min(50).to_string())),
        ("offset".into(), Some(offset.to_string())),
        ("q".into(), Some(q.to_string())),
        ("type".into(), Some(kind.param().to_string())),
    ];
    if let Some(o) = offsets {
        for (k, v) in o {
            let v = match v {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            params.push((format!("{k}_offset"), Some(v)));
        }
    }
    let borrowed: Vec<(&str, Option<String>)> = params.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
    let mut path = format!("/api/search{}", query(&borrowed));
    if let Some(o) = offsets {
        let keys: Vec<&str> = o.keys().map(String::as_str).collect();
        path.push_str(&format!("&streams={}", urlencoding::encode(&keys.join(","))));
    }
    let r: SearchResponse = c.get(&path)?;
    let mut items = Vec::new();
    items.extend(r.artists.into_iter().map(SearchItem::Artist));
    items.extend(r.albums.into_iter().map(SearchItem::Album));
    items.extend(r.tracks.into_iter().map(SearchItem::Track));
    Ok(SearchPage { items, next_offsets: r.next_offsets.unwrap_or_default(), warnings: r.warnings })
}

/// `api.getAlbum` + `api.listAlbumTracks`.
pub fn get_album(c: &Client, id: &str) -> ApiResult<(Album, Vec<TrackListItem>)> {
    let album: Album = c.get(&format!("/api/albums/{}", seg(id)))?;
    let tracks: Option<Vec<TrackListItem>> = c.get(&format!("/api/albums/{}/tracks", seg(id)))?;
    Ok((album, tracks.unwrap_or_default()))
}

/// `api.getArtist` + `api.listArtistTracks`.
pub fn get_artist(c: &Client, id: &str) -> ApiResult<(Artist, Vec<TrackListItem>)> {
    let artist: Artist = c.get(&format!("/api/artists/{}", seg(id)))?;
    let tracks: Option<Vec<TrackListItem>> = c.get(&format!("/api/artists/{}/tracks", seg(id)))?;
    Ok((artist, tracks.unwrap_or_default()))
}

/// `api.getTidalAlbum`.
pub fn get_tidal_album(c: &Client, id: &str) -> ApiResult<TidalAlbum> {
    c.get(&format!("/api/tidal/albums/{}", seg(id)))
}

/// `api.getTidalArtist`.
pub fn get_tidal_artist(c: &Client, id: &str) -> ApiResult<TidalArtist> {
    c.get(&format!("/api/tidal/artists/{}", seg(id)))
}

/// `api.downloadTidalAlbum` (admin).
pub fn download_tidal_album(c: &Client, id: &str) -> ApiResult<()> {
    c.send("POST", &format!("/api/admin/tidal/albums/{}/download", seg(id)), crate::api::Body::None).map(|_| ())
}

/// `api.cancelTidalAlbumDownload` (admin).
pub fn cancel_tidal_album_download(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/admin/tidal/albums/{}/download", seg(id)))
}

/// `errorMessage(err, fallback)`: the server's message, else the fallback.
pub fn error_message(e: &crate::api::ApiError, fallback: &str) -> String {
    if e.message.is_empty() || e.status == 0 { fallback.to_string() } else { e.message.clone() }
}
