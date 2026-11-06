//! `core/src/playlist-details.ts`: a playlist's editable details (name,
//! description, visibility) and cover, as the create and edit forms send
//! them. Both text fields are trimmed; a blank name is caught before the
//! request.

use crate::api::{EffectiveRole, Playlist, Visibility};

/// The form's values, and the body `create_playlist` / `update_playlist` take.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct PlaylistDetails {
    pub name: String,
    pub description: String,
    pub visibility: Visibility,
}

/// `playlistDetailsPayload`: what to send, trimmed.
pub fn playlist_details_payload(draft: &PlaylistDetails) -> PlaylistDetails {
    PlaylistDetails {
        name: draft.name.trim().to_string(),
        description: draft.description.trim().to_string(),
        visibility: draft.visibility,
    }
}

/// `playlistDetailsForm`: an edit form's starting values, untrimmed as they show.
pub fn playlist_details_form(p: &Playlist) -> PlaylistDetails {
    PlaylistDetails { name: p.name.clone(), description: p.description.clone().unwrap_or_default(), visibility: p.visibility }
}

/// The server's rule: a name with something besides whitespace.
pub fn is_valid_playlist_name(name: &str) -> bool {
    !name.trim().is_empty()
}

/// Whether two drafts would save the same details.
pub fn same_playlist_details(a: &PlaylistDetails, b: &PlaylistDetails) -> bool {
    playlist_details_payload(a) == playlist_details_payload(b)
}

/// The server's cap on a cover upload; checked first to skip a doomed upload.
pub const PLAYLIST_COVER_MAX_BYTES: u64 = 16 << 20;

/// The message for a cover image over the cap; an unknown size passes.
pub fn playlist_cover_size_error(bytes: Option<u64>) -> Option<&'static str> {
    bytes.filter(|b| *b > PLAYLIST_COVER_MAX_BYTES).map(|_| "That image is over 16 MB. Choose a smaller one.")
}

/// The line under a playlist's name in lists and pickers: its visibility,
/// then your role on it when it isn't yours ("Collaborative · editor").
pub fn playlist_subtitle(visibility: Visibility, role: Option<EffectiveRole>) -> String {
    let v = if visibility == Visibility::Collaborative { "Collaborative" } else { "Private" };
    match role {
        Some(r @ (EffectiveRole::Editor | EffectiveRole::Viewer)) => format!("{v} · {}", r.as_str()),
        _ => v.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(name: &str, description: &str, visibility: Visibility) -> PlaylistDetails {
        PlaylistDetails { name: name.into(), description: description.into(), visibility }
    }

    #[test]
    fn trims_name_and_description() {
        assert_eq!(
            playlist_details_payload(&d("  Road trip ", "  Long drives\n", Visibility::Collaborative)),
            d("Road trip", "Long drives", Visibility::Collaborative)
        );
        assert_eq!(playlist_details_payload(&d("Mix", "", Visibility::Private)).description, "");
    }

    #[test]
    fn fills_the_form_from_a_saved_playlist() {
        let mut p: Playlist = serde_json::from_str(r#"{"id":"p","name":"Mix ","description":"Late","visibility":"collaborative"}"#).unwrap();
        assert_eq!(playlist_details_form(&p), d("Mix ", "Late", Visibility::Collaborative));
        p.name = "Mix".into();
        p.description = None;
        p.visibility = Visibility::Private;
        let form = playlist_details_form(&p);
        assert_eq!(form, d("Mix", "", Visibility::Private));
        assert!(same_playlist_details(&form, &d("Mix", "", Visibility::Private)));
    }

    #[test]
    fn validates_names() {
        assert!(!is_valid_playlist_name(""));
        assert!(!is_valid_playlist_name("   \t"));
        assert!(is_valid_playlist_name(" a "));
    }

    #[test]
    fn compares_after_trimming() {
        let saved = d("Mix", "Notes", Visibility::Private);
        assert!(same_playlist_details(&saved, &d("Mix ", "Notes", Visibility::Private)));
        assert!(same_playlist_details(&saved, &d("Mix", " Notes ", Visibility::Private)));
        assert!(!same_playlist_details(&saved, &d("Mix", "Notes", Visibility::Collaborative)));
        assert!(!same_playlist_details(&saved, &d("Mix", "Other", Visibility::Private)));
    }

    #[test]
    fn cover_size_cap() {
        assert_eq!(PLAYLIST_COVER_MAX_BYTES, 16 * 1024 * 1024);
        assert_eq!(playlist_cover_size_error(Some(PLAYLIST_COVER_MAX_BYTES)), None);
        assert!(playlist_cover_size_error(Some(PLAYLIST_COVER_MAX_BYTES + 1)).unwrap().contains("over 16 MB"));
        assert_eq!(playlist_cover_size_error(None), None);
    }

    #[test]
    fn subtitles() {
        use EffectiveRole as R;
        assert_eq!(playlist_subtitle(Visibility::Private, Some(R::Owner)), "Private");
        assert_eq!(playlist_subtitle(Visibility::Collaborative, Some(R::Owner)), "Collaborative");
        assert_eq!(playlist_subtitle(Visibility::Collaborative, Some(R::Editor)), "Collaborative · editor");
        assert_eq!(playlist_subtitle(Visibility::Collaborative, Some(R::Viewer)), "Collaborative · viewer");
        assert_eq!(playlist_subtitle(Visibility::Collaborative, None), "Collaborative");
        assert_eq!(playlist_subtitle(Visibility::Private, Some(R::None)), "Private");
    }
}
