//! The server API, as `@music-library/core`'s `api` module is for the web:
//! the transport ([`client`]), payloads ([`types`] and each area's own),
//! media URLs ([`media`]) and one module of blocking calls per area. Every
//! call takes a [`Client`]; run them on `app.net` workers.
//!
//! | Module | `core/src/api.ts` methods |
//! | --- | --- |
//! | [`auth`] | login, logout, me, register, checkInvite, resetPassword |
//! | [`admin`] | users, invites, music roots, ingest errors, rescan, global track tools |
//! | [`sources`] | tracker / Filen / API-tracker pins and their downloads |
//! | [`library`] | tracks, albums, artists, track and album edits, recent |
//! | [`search`] | search, searchPage, searchTracks, nextPageParam |
//! | [`playlists`] | playlists, tracks (ETag reads), collaborators, invites |
//! | [`favorites`] | favorite, unfavorite, listFavorites |
//! | [`activity`] | plays, scrobbles, now playing, playback activity |
//! | [`stats`] | Replay data, playlist and share image |
//! | [`lyrics`] | getLyrics |
//! | [`tidal`] | TIDAL pages, status, device login, auto-download |
//! | [`lastfm`] | Last.fm status, connect, wait, disconnect |
//! | [`share`] | share links, public shares, story videos |
//! | [`upload`] | music and cover uploads (multipart, progress) |
//! | [`media`] | stream, cover and art URLs; signed covers |
pub mod activity;
pub mod admin;
pub mod auth;
pub mod client;
pub mod de;
pub mod favorites;
pub mod lastfm;
pub mod library;
pub mod lyrics;
pub mod media;
pub mod playlists;
pub mod search;
pub mod share;
pub mod sources;
pub mod stats;
#[cfg(test)]
pub mod testing;
pub mod tidal;
pub mod types;
pub mod upload;

// The pages use these as they land.
#[allow(unused_imports)]
pub use client::{
    ApiError, ApiResult, Behavior, Body, Cancel, Client, ErrorKind, Notify, Progress, error_message, query, seg,
};
pub use types::*;
