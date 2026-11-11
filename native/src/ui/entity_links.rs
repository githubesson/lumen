//! Shared navigation for song titles and credited artists.
use crate::{app::App, api::TrackListItem};

pub fn album(app: &mut App, track: TrackListItem) {
    let Some(client) = app.client.clone() else { return };
    app.net.run(move || crate::core::entity_target::resolve_track_album_target_with(&client, &track), |app, result| {
        if let Ok(Some(target)) = result { app.navigate_to(&target.album_href()); }
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
    let names = track.artist.as_deref().unwrap_or("Unknown artist");
    let mut view = rune::text(names.to_owned()).font(style).color(color);
    let mut start = 0;
    for name in names.split(", ") {
        let end = start + name.len();
        view = view.link(rune::Link::new(start..end, name.to_owned()).hover(rune::LinkPaint::new().underline(color)));
        start = end + 2;
    }
    let track = track.clone();
    view.on_link(move |app: &mut App, name: &str, _| artist(app, track.clone(), name.to_owned()))
}
