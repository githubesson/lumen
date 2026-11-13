//! `EntityLinks.tsx` (`PageLink`, `ArtistLinks`) and `nowPlayingLinks.ts`: a
//! track's title, artists and album as text that opens their pages. Each is
//! a link range in its line, so the line's ellipsis cuts it like the words
//! around it. The page is looked up when one is pressed; a lookup that
//! fails or finds nothing leaves the page as it is.

use std::ops::Range;

use rune::{Color, El, Link, LinkPaint, TextStyle};

use crate::api::TrackListItem;
use crate::app::App;
use crate::format::display_text;

/// `artistNames`: the names in a track's comma-joined artist line.
pub fn artist_names(artist: Option<&str>) -> Vec<&str> {
    artist.unwrap_or("").split(", ").map(str::trim).filter(|n| !n.is_empty()).collect()
}

/// A line of text with links in it. A link's id says what it opens:
/// `artist:{n}` the `n`th of [`artist_names`], `album` the track's album.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Linked {
    pub text: String,
    pub links: Vec<(Range<usize>, String)>,
}

impl Linked {
    fn link(&mut self, s: &str, id: String) {
        let start = self.text.len();
        self.text.push_str(s);
        self.links.push((start..self.text.len(), id));
    }
}

/// `ArtistLinks`: each of the track's artists, or `fallback` (unlinked) when
/// it names none.
pub fn artist_links(track: &TrackListItem, fallback: &str) -> Linked {
    let mut line = Linked::default();
    for (n, name) in artist_names(track.artist.as_deref()).into_iter().enumerate() {
        if n > 0 {
            line.text.push_str(", ");
        }
        line.link(&display_text(Some(name), name), format!("artist:{n}"));
    }
    if line.text.is_empty() {
        line.text = fallback.to_string();
    }
    line
}

/// The player's artist line: [`artist_links`] ("—" for none), then the
/// album after a dot.
pub fn np_artist_links(track: &TrackListItem) -> Linked {
    let mut line = artist_links(track, "—");
    let album = display_text(track.album_title.as_deref(), "");
    if !album.is_empty() {
        line.text.push_str(" · ");
        line.link(&album, "album".into());
    }
    line
}

/// The title as one link to its album (the player's `.np-title`).
pub fn album_title_link(title: &str) -> Linked {
    let mut line = Linked::default();
    line.link(title, "album".into());
    line
}

/// `line` on one line, cut with an ellipsis, its links underlined while
/// hovered (`.entity-link`) and opening `track`'s pages.
pub fn line(track: &TrackListItem, line: Linked, style: TextStyle, color: Color) -> El {
    links(crate::ui::line(line.text.clone(), style, color), track, &line, color)
}

/// `line`'s links on a text element of one's own (a wrapped title).
pub fn links(mut e: El, track: &TrackListItem, line: &Linked, color: Color) -> El {
    for (range, id) in &line.links {
        e = e.link(Link::new(range.clone(), id.clone()).hover(LinkPaint::new().underline(color)));
    }
    let track = track.clone();
    e.on_link(move |app: &mut App, id: &str, _tx: &mut rune::Tx| open(app, &track, id))
}

fn open(app: &mut App, track: &TrackListItem, id: &str) {
    if id == "album" {
        return open_album(app, track);
    }
    let names = artist_names(track.artist.as_deref());
    if let Some(name) = id.strip_prefix("artist:").and_then(|n| n.parse::<usize>().ok()).and_then(|n| names.get(n)) {
        open_artist(app, track, name);
    }
}

/// `trackAlbumHref`: the track's album page, when it has one.
pub fn open_album(app: &mut App, track: &TrackListItem) {
    let Some(client) = app.client.clone() else { return };
    let track = track.clone();
    app.net.run(
        move || crate::core::entity_target::resolve_track_album_target_with(&client, &track),
        |app, target| {
            if let Ok(Some(target)) = target {
                app.navigate_to(&target.album_href());
            }
        },
    );
}

/// The artist search for `name`.
pub fn artist_search_href(name: &str) -> String {
    format!("/library?view=artists&q={}", urlencoding::encode(name))
}

/// `trackArtistHref`: the page for one of a track's artists, by the name
/// shown. A library track's artists (not its composers) have library pages;
/// a TIDAL track's, or a name the detail doesn't list, open the artist
/// search instead.
pub fn open_artist(app: &mut App, track: &TrackListItem, name: &str) {
    if crate::core::track::is_tidal_track(track) {
        return app.navigate_to(&artist_search_href(name));
    }
    let Some(client) = app.client.clone() else { return };
    let (id, name) = (track.id.clone(), name.to_string());
    app.net.run(
        move || crate::api::library::get_track(&client, &id),
        move |app, detail| {
            let Ok(detail) = detail else { return };
            app.navigate_to(&artist_href(&detail.artists, &name));
        },
    );
}

/// Where a library track's artist `name` goes, from its detail's artists.
fn artist_href(artists: &[crate::api::TrackArtist], name: &str) -> String {
    match artists.iter().find(|a| a.role != "composer" && a.name == name) {
        Some(a) => super::cards::artist_href(&a.id),
        None => artist_search_href(name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::TrackArtist;

    fn track(artist: Option<&str>, album: Option<&str>) -> TrackListItem {
        TrackListItem { title: "Song".into(), artist: artist.map(String::from), album_title: album.map(String::from), ..Default::default() }
    }

    fn spans(l: &Linked) -> Vec<(&str, &str)> {
        l.links.iter().map(|(r, id)| (&l.text[r.clone()], id.as_str())).collect()
    }

    #[test]
    fn each_artist_is_its_own_range() {
        let l = artist_links(&track(Some("Ålice, Bob feat. C,  Dee"), None), "Unknown artist");
        assert_eq!(l.text, "Ålice, Bob feat. C, Dee");
        assert_eq!(spans(&l), vec![("Ålice", "artist:0"), ("Bob feat. C", "artist:1"), ("Dee", "artist:2")]);
        // Mangled text is cleaned as it's shown; the id still finds the raw name.
        let l = artist_links(&track(Some("Sigur RÂ·s, Bob"), None), "");
        assert_eq!(spans(&l), vec![("Sigur R·s", "artist:0"), ("Bob", "artist:1")]);
    }

    #[test]
    fn no_artist_is_the_fallback_unlinked() {
        for artist in [None, Some(""), Some(" , ")] {
            let l = artist_links(&track(artist, None), "Unknown artist");
            assert_eq!((l.text.as_str(), l.links.len()), ("Unknown artist", 0), "{artist:?}");
        }
    }

    #[test]
    fn the_player_line_adds_the_album_after_a_dot() {
        let l = np_artist_links(&track(Some("Alice, Bob"), Some("Record")));
        assert_eq!(l.text, "Alice, Bob · Record");
        assert_eq!(spans(&l), vec![("Alice", "artist:0"), ("Bob", "artist:1"), ("Record", "album")]);
        let l = np_artist_links(&track(None, Some("Record")));
        assert_eq!((l.text.as_str(), spans(&l)), ("— · Record", vec![("Record", "album")]));
        // An empty album leaves no dangling dot.
        for album in [None, Some(""), Some("  ")] {
            assert_eq!(np_artist_links(&track(Some("Alice"), album)).text, "Alice");
        }
        assert_eq!(spans(&album_title_link("Song")), vec![("Song", "album")]);
    }

    #[test]
    fn artists_open_their_library_page_but_composers_dont() {
        let a = |id: &str, name: &str, role: &str| TrackArtist { id: id.into(), name: name.into(), role: role.into() };
        let artists = [a("c1", "Alice", "composer"), a("a1", "Alice", "primary"), a("a2", "Bob", "featured")];
        assert_eq!(artist_href(&artists, "Alice"), "/library?view=artists&artist=a1");
        assert_eq!(artist_href(&artists[..1], "Alice"), "/library?view=artists&q=Alice");
        assert_eq!(artist_href(&artists, "Dee & Co"), "/library?view=artists&q=Dee%20%26%20Co");
    }
}
