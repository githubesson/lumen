//! `usePlayerDisplay.ts`: what the bar shows, the local player or a remote
//! device being controlled. The player's public fields already follow a
//! remote target (its track, play state, volume, shuffle and repeat), so the
//! bar agrees with the queue and lyrics views.

use crate::api::TrackListItem;
use crate::app::App;
use crate::format::display_text;

pub struct Display<'a> {
    pub current: Option<&'a TrackListItem>,
    pub remote: bool,
    pub title: String,
    pub artist: String,
    /// Why the current track stopped, shown in place of its artist.
    pub error: Option<String>,
    /// Previous, play/pause and next need a track to act on. A pending
    /// remote command doesn't disable them: the target applies commands in
    /// order, so a quick second "next" should skip again.
    pub transport_disabled: bool,
    /// Shuffle and repeat wait for a pending remote command.
    pub command_pending: bool,
}

/// The current track's artist line: "Artist · Album".
pub fn artist_line(t: &TrackListItem) -> String {
    let artist = display_text(t.artist.as_deref(), "—");
    match t.album_title.as_deref().filter(|s| !s.is_empty()) {
        Some(album) => format!("{artist} · {}", display_text(Some(album), "")),
        None => artist,
    }
}

/// The failure to show: the current track's own.
pub fn shown_error(app: &App) -> Option<&crate::player::PlaybackError> {
    let p = &app.player;
    let current = p.current()?;
    p.error.as_ref().filter(|e| e.track_id == current.id)
}

pub fn display(app: &App) -> Display<'_> {
    let p = &app.player;
    let target = p.target_device();
    let current = p.current();
    let title = match current {
        Some(t) => display_text(Some(&t.title), &none_title(target.map(|d| d.device_name.as_str()))),
        None => none_title(target.map(|d| d.device_name.as_str())),
    };
    let artist = match current {
        Some(t) => artist_line(t),
        None => target.map(|d| d.device_name.clone()).unwrap_or_else(|| "—".into()),
    };
    Display {
        current,
        remote: target.is_some(),
        title,
        artist,
        error: shown_error(app).map(|e| e.summary.clone()),
        transport_disabled: current.is_none(),
        command_pending: p.command_pending(),
    }
}

fn none_title(device: Option<&str>) -> String {
    match device {
        Some(name) => format!("Nothing playing on {name}"),
        None => "Nothing playing".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_artist_line_names_the_album_after_a_dot() {
        let t = TrackListItem { title: "A song".into(), artist: Some("Someone".into()), album_title: Some("A record".into()), ..Default::default() };
        assert_eq!(artist_line(&t), "Someone · A record");
        let t = TrackListItem { title: "A song".into(), ..Default::default() };
        assert_eq!(artist_line(&t), "—");
    }
}
