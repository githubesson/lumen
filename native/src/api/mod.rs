//! The server API: transport ([`client`]), payloads ([`types`]) and media
//! URLs ([`media`]), as `@music-library/core`'s `api` module is for the web.
pub mod client;
pub mod media;
pub mod types;

pub use client::{ApiError, ApiResult, Body, Client, query, seg};
pub use types::*;
