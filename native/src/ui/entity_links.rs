//! Shared navigation for song titles and credited artists.
use crate::{app::App, api::TrackListItem};

pub fn album(app: &mut App, track: TrackListItem) {
    if let Some(target) = crate::core::entity_target::track_album_target(&track) {
        app.navigate_to(&target.album_href());
        return;
    }
    let query = track.album_title.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or(&track.title);
    let fallback = format!("/library?q={}", urlencoding::encode(query));
    let Some(client) = app.client.clone() else { app.navigate_to(&fallback); return };
    app.net.run(move || crate::core::entity_target::resolve_track_album_target_with(&client, &track), move |app, result| {
        let href = result.ok().flatten().map(|target| target.album_href()).unwrap_or(fallback);
        app.navigate_to(&href);
    });
}

pub fn artist_search(name: &str) -> String {
    format!("/library?view=artists&type=artist&q={}", urlencoding::encode(name))
}

pub fn artist(app: &mut App, track: TrackListItem, name: String) {
    let Some(client) = app.client.clone() else { return };
    app.net.run(move || {
        if crate::core::track::is_tidal_track(&track) {
            let id = crate::api::search::search_entity_id(&track.id, track.source, track.source_id.as_deref());
            crate::api::tidal::get_tidal_track(&client, &id).map(|info| {
                info.artists.into_iter().find(|a| a.name == name).and_then(|a| a.id)
                    .filter(|id| !id.is_empty())
                    .map(|id| format!("/library?tidalArtist={}&artistName={}", urlencoding::encode(&id), urlencoding::encode(&name)))
                    .unwrap_or_else(|| artist_search(&name))
            }).unwrap_or_else(|_| artist_search(&name))
        } else {
            crate::api::library::get_track(&client, &track.id).ok()
                .and_then(|detail| detail.artists.into_iter().find(|a| a.name == name))
                .map(|a| format!("/library?view=artists&artist={}", urlencoding::encode(&a.id)))
                .unwrap_or_else(|| artist_search(&name))
        }
    }, |app, href| app.navigate_to(&href));
}

pub fn artists(track: &TrackListItem, style: rune::TextStyle, color: rune::Color) -> rune::El {
    let label = crate::format::display_text(track.artist.as_deref(), "Unknown artist");
    artists_label(track, &label, style, color)
}

/// Keep appended playlist attribution visible, but link only artist credits.
pub fn artists_label(track: &TrackListItem, label: &str, style: rune::TextStyle, color: rune::Color) -> rune::El {
    let names = crate::format::clean_text(track.artist.as_deref());
    let mut view = crate::ui::line(label.to_owned(), style, color);
    let mut start = 0;
    for name in names.split(", ") {
        let end = start + name.len();
        if !name.trim().is_empty() {
            view = view.link(rune::Link::new(start..end, name.to_owned()).hover(rune::LinkPaint::new().underline(color)));
        }
        start = end + 2;
    }
    let track = track.clone();
    view.on_link(move |app: &mut App, name: &str, tx| {
        reveal_library(app, tx);
        artist(app, track.clone(), name.to_owned());
    })
}

/// A metadata label opens its source album, keeping playback on its own control.
pub fn album_label(label: rune::El, track: &TrackListItem, t: &crate::theme::Theme) -> rune::El {
    let track = track.clone();
    label.hover(t.c.ghost_hover)
        .hover_motion(crate::ui::motion::ease(140.0), crate::ui::motion::ease(140.0))
        .focusable(true).cursor(rune::Cursor::Pointer)
        .role("link").label(format!("Open album for {}", track.title))
        .on_press_tx(move |app: &mut App, tx| {
            reveal_library(app, tx);
            album(app, track.clone());
        })
}

pub fn reveal_library(app: &mut App, tx: &mut rune::Tx) {
    crate::shell::player::close_popover(app);
    if app.ui.player.mini.on {
        crate::shell::player::mini::toggle_mode(app, tx);
    }
}

/// Cover navigation uses the same destination as the title, with a fading tint.
pub fn album_cover(view: rune::El, track: &TrackListItem, t: &crate::theme::Theme) -> rune::El {
    let track = track.clone();
    crate::ui::cover_link(t, view)
        .hover_motion(crate::ui::motion::ease(140.0), crate::ui::motion::ease(140.0))
        .label(format!("Open album for {}", track.title))
        .on_press_tx(move |app: &mut App, tx| {
            reveal_library(app, tx);
            album(app, track.clone());
        })
}
