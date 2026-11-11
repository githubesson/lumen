//! Optional metadata applied only to tracks newly inserted by this upload.
use std::{collections::HashMap, path::PathBuf};
use crate::api::{Client, Cancel, TrackPatch, UploadResult};
use crate::core::upload::UploadScope;

#[derive(Clone, Default)]
pub struct Edits {
    pub patches: HashMap<PathBuf, TrackPatch>,
    pub cover: Option<PathBuf>,
}

pub fn patch(title: &str, artists: &str, album: &str, album_artist: &str) -> TrackPatch {
    let nonempty = |s: &str| (!s.trim().is_empty()).then(|| s.trim().to_owned());
    let artists: Vec<String> = artists.split(',').map(str::trim).filter(|s| !s.is_empty()).map(Into::into).collect();
    TrackPatch {
        title: nonempty(title), artists: (!artists.is_empty()).then_some(artists),
        album_title: nonempty(album), album_artist: if album.trim().is_empty() { None } else { nonempty(album_artist) },
        ..Default::default()
    }
}

pub fn apply(client: &Client, files: &[PathBuf], results: &mut [UploadResult], edits: &Edits, scope: UploadScope, cancel: &Cancel) {
    let mut covered = std::collections::HashSet::new();
    for (file, result) in files.iter().zip(results.iter_mut()) {
        if cancel.is_cancelled() { break; }
        if !result.inserted { continue; }
        let Some(id) = result.track_id.as_deref() else { continue };
        let patch = edits.patches.get(file).filter(|p| **p != TrackPatch::default());
        if patch.is_none() && edits.cover.is_none() { continue; }
        let saved = (|| {
            let track = match patch {
                Some(patch) => crate::api::library::update_track(client, id, patch)?,
                None => crate::api::library::get_track(client, id)?,
            };
            if let Some(cover) = &edits.cover {
                if scope == UploadScope::Personal {
                    if track.album_id.as_ref().is_none_or(|album| !covered.contains(album)) {
                        crate::api::upload::set_track_cover(client, id, cover)?;
                        if let Some(album) = track.album_id { covered.insert(album); }
                    }
                } else if let Some(album) = track.album_id {
                    if !covered.contains(&album) {
                        crate::api::upload::set_album_cover(client, &album, cover)?;
                        covered.insert(album);
                    }
                } else {
                    return Err(crate::api::ApiError::local(0, "Set an album to add shared cover art."));
                }
            }
            Ok::<_, crate::api::ApiError>(())
        })();
        if let Err(e) = saved { result.error = Some(format!("Added, but saving the details failed: {e}")); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blanks_preserve_file_tags_and_album_artist_needs_an_album() {
        assert_eq!(patch(" ", " , ", "", "Name"), TrackPatch::default());
        let p = patch(" Song ", "Alice, Bob", " Record ", " Alice ");
        assert_eq!(p.title.as_deref(), Some("Song"));
        assert_eq!(p.artists, Some(vec!["Alice".into(), "Bob".into()]));
        assert_eq!(p.album_title.as_deref(), Some("Record"));
        assert_eq!(p.album_artist.as_deref(), Some("Alice"));
    }
}
