//! The platform-neutral logic of `@music-library/core` (`core/src/`) and the
//! web's pure page helpers (`frontend/src/lib/`), for the pages to share.
//! Formatting is [`crate::format`]; requests are [`crate::api`].
pub mod admin;
pub mod artist_releases;
pub mod audio_format;
pub mod auth;
pub mod dates;
pub mod downloads;
pub mod entity_labels;
pub mod entity_target;
pub mod js;
pub mod lastfm;
pub mod lyrics;
pub mod metadata_edit;
pub mod playlist_details;
pub mod playlist_permissions;
pub mod playlist_tracks;
pub mod replay;
pub mod share_link_session;
pub mod share_snippet;
pub mod tidal;
pub mod track;
pub mod track_menu;
pub mod track_sort;
pub mod upload;
