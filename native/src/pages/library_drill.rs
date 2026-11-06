//! `lib/libraryDrill.ts`: the params that open an album or artist inside
//! /library.
use crate::route::Location;

const DRILL_PARAMS: [&str; 4] = ["album", "artist", "tidalAlbum", "tidalArtist"];

pub fn has_drill(loc: &Location) -> bool {
    DRILL_PARAMS.iter().any(|k| loc.get(k).is_some_and(|v| !v.is_empty()))
}

pub fn without_drill(loc: &Location) -> Location {
    let mut next = loc.clone();
    next.query.retain(|(k, _)| !DRILL_PARAMS.contains(&k.as_str()) && k != "artistName");
    next
}
