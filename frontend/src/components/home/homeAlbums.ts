import type { TrackListItem } from "../../api";
import { trackAlbumTarget } from "@music-library/core/entity-target";

export interface HomeAlbum {
  /** The library album id. */
  id: string;
  title: string;
  artist: string;
}

/**
 * The library albums `tracks` belong to, each once, in the order their first
 * track appears (Home passes the newest tracks, so the newest albums lead).
 *
 * Tracks are grouped by album, not by their artist line: a track with a
 * featured guest ("Halden Marsh, Hana Okoro") is still on the same album.
 * The album's artist is the line most of its tracks carry (the first one
 * seen on a tie). Tracks without a library album are left out, since there
 * would be no album to open or play.
 */
export function homeAlbums(tracks: readonly TrackListItem[]): HomeAlbum[] {
  const albums = new Map<string, { title: string; artists: Map<string, number> }>();
  for (const track of tracks) {
    const target = trackAlbumTarget(track);
    const title = track.album_title?.trim();
    if (target?.kind !== "local" || !title) continue;
    let album = albums.get(target.id);
    if (!album) {
      album = { title, artists: new Map() };
      albums.set(target.id, album);
    }
    const artist = track.artist?.trim() || "Unknown artist";
    album.artists.set(artist, (album.artists.get(artist) ?? 0) + 1);
  }
  return [...albums].map(([id, album]) => {
    let artist = "Unknown artist";
    let most = 0;
    for (const [name, count] of album.artists) {
      if (count > most) {
        artist = name;
        most = count;
      }
    }
    return { id, title: album.title, artist };
  });
}
