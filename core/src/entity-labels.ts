import type { Album, TidalAlbum, TrackSource } from "./api";
import { displayText, pluralize } from "./format";

/**
 * Subtitle and meta lines for albums and artists, built the same way on both
 * clients: parts joined with " · ", counts through `pluralize`, names cleaned
 * with `displayText`. Functions ending in `Parts` return the pieces for call
 * sites that render them separately.
 */

const SEPARATOR = " · ";

function joinParts(parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter(Boolean).join(SEPARATOR);
}

/** One fact on an album page, keyed so a client can annotate a kind of part. */
export interface AlbumMetaPart {
  key: "tracks" | "saved" | "year";
  text: string;
}

type AlbumCardFields = Pick<Album, "artist_name" | "is_compilation" | "track_count"> & {
  source?: TrackSource;
};

type ArtistCardFields = { track_count: number; album_count: number; source?: TrackSource };

/** The artist a card credits an album to, with a fallback when it has none. */
export function albumArtistName(album: Pick<Album, "artist_name" | "is_compilation">): string {
  return (
    displayText(album.artist_name) ||
    (album.is_compilation ? "Various Artists" : "Unknown artist")
  );
}

/**
 * "Artist · 12 tracks · TIDAL" for an album card or row. Rows that show the
 * track count on their own pass `trackCount: false`.
 */
export function albumSubtitle(
  album: AlbumCardFields,
  { trackCount = true }: { trackCount?: boolean } = {},
): string {
  return joinParts([
    albumArtistName(album),
    trackCount && pluralize(album.track_count, "track"),
    album.source === "tidal" && "TIDAL",
  ]);
}

/**
 * Who an album page credits: every main artist of a TIDAL release when known,
 * else the album artist. Empty when unknown, since the pages then omit it.
 */
export function albumArtists(album: {
  artist_names?: string[];
  artist_name?: string;
  artists?: string[];
  artist?: string;
}): string {
  const names = album.artist_names?.length ? album.artist_names : album.artists;
  return displayText(names?.join(", ") || album.artist_name || album.artist);
}

function albumMetaParts(
  trackCount: number,
  savedCount: number | undefined,
  releaseYear: number | undefined,
): AlbumMetaPart[] {
  const parts: AlbumMetaPart[] = [{ key: "tracks", text: pluralize(trackCount, "track") }];
  if (savedCount !== undefined) parts.push({ key: "saved", text: `${savedCount} saved` });
  if (releaseYear) parts.push({ key: "year", text: String(releaseYear) });
  return parts;
}

/** "12 tracks", "3 saved", "2021" under a library album page's title. */
export function libraryAlbumMetaParts(
  album: Pick<Album, "track_count" | "tidal_album_id" | "saved_count" | "release_year">,
): AlbumMetaPart[] {
  // Only an album copying a TIDAL release has a part to save.
  const saved = album.tidal_album_id ? album.saved_count : undefined;
  return albumMetaParts(album.track_count, saved, album.release_year);
}

/** The same for a TIDAL album page, where nothing saved is the usual case. */
export function tidalAlbumMetaParts(
  album: Pick<TidalAlbum, "track_count" | "saved_count" | "release_year">,
): AlbumMetaPart[] {
  return albumMetaParts(album.track_count, album.saved_count || undefined, album.release_year);
}

/** "12 tracks · 3 albums", or "TIDAL artist" for one from search. */
export function artistMetaParts(artist: ArtistCardFields): string[] {
  return [
    artist.source === "tidal" ? "TIDAL artist" : pluralize(artist.track_count, "track"),
    artist.album_count > 0 ? pluralize(artist.album_count, "album") : "",
  ].filter(Boolean);
}

export function artistSubtitle(artist: ArtistCardFields): string {
  return joinParts(artistMetaParts(artist));
}

/** "8 releases · 10 popular tracks" under a TIDAL artist page's name. */
export function tidalArtistMetaParts(releaseCount: number, popularTrackCount: number): string[] {
  return [
    releaseCount > 0 ? pluralize(releaseCount, "release") : "",
    popularTrackCount > 0 ? pluralize(popularTrackCount, "popular track") : "",
  ].filter(Boolean);
}

/** Meta parts joined for a single line. */
export function metaLine(parts: readonly (string | AlbumMetaPart)[]): string {
  return joinParts(parts.map((part) => (typeof part === "string" ? part : part.text)));
}
