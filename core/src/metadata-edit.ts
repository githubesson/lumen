import type { TrackDetail, TrackPatch, Album, AlbumPatch } from "./api";
import { displayArtists } from "./api-media";

export interface TrackEditForm {
  title: string;
  artists: string;
  albumTitle: string;
  albumArtist: string;
  year: string;
  genre: string;
  trackNo: string;
  discNo: string;
}

export interface AlbumEditForm {
  title: string;
  albumArtist: string;
  year: string;
  isCompilation: boolean;
}

/**
 * The edit form for a loaded track: the inverse of {@link buildTrackPatch},
 * so an untouched form diffs to an empty patch. Unset numbers are blank.
 */
export function trackEditForm(track: TrackDetail): TrackEditForm {
  return {
    title: track.title,
    artists: displayArtists(track),
    albumTitle: track.album_title ?? "",
    // album_artist isn't on TrackDetail, so it starts blank (compilations
    // stay "Various Artists"; otherwise the server keeps the primary artist).
    albumArtist: "",
    year: track.year ? String(track.year) : "",
    genre: track.genre ?? "",
    trackNo: track.track_no ? String(track.track_no) : "",
    discNo: track.disc_no ? String(track.disc_no) : "",
  };
}

/** The edit form for a loaded album: the inverse of {@link buildAlbumPatch}. */
export function albumEditForm(album: Album): AlbumEditForm {
  return {
    title: album.title,
    albumArtist: album.artist_name ?? "",
    year: album.release_year ? String(album.release_year) : "",
    isCompilation: album.is_compilation,
  };
}

/**
 * Diff the form against the loaded track and return only the fields that
 * actually changed, so the server PATCH stays
 * minimal. An untouched album-artist field is never sent (it isn't part of
 * TrackDetail, so there's nothing to compare it against).
 */
export function buildTrackPatch(track: TrackDetail, form: TrackEditForm): TrackPatch {
  const patch: TrackPatch = {};
  const title = form.title.trim();
  if (title && title !== track.title) patch.title = title;

  const parsedArtists = form.artists
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const currentArtists = track.artists
    .filter((a) => a.role !== "composer")
    .map((a) => a.name);
  if (
    parsedArtists.length !== currentArtists.length ||
    parsedArtists.some((artist, index) => artist !== currentArtists[index])
  ) {
    patch.artists = parsedArtists;
  }

  const albumTitle = form.albumTitle.trim();
  if (albumTitle !== (track.album_title ?? "")) patch.album_title = albumTitle;
  const albumArtist = form.albumArtist.trim();
  if (albumArtist !== "") patch.album_artist = albumArtist;

  const year = parseInt(form.year || "0", 10) || 0;
  if ((track.year ?? 0) !== year) patch.year = year;

  const genre = form.genre.trim();
  if ((track.genre ?? "") !== genre) patch.genre = genre;

  const tn = parseInt(form.trackNo || "0", 10) || 0;
  if ((track.track_no ?? 0) !== tn) patch.track_no = tn;
  const dn = parseInt(form.discNo || "0", 10) || 0;
  if ((track.disc_no ?? 0) !== dn) patch.disc_no = dn;

  return patch;
}

export function buildAlbumPatch(album: Album, form: AlbumEditForm): AlbumPatch {
  const patch: AlbumPatch = {};
  const title = form.title.trim();
  if (title && title !== album.title) patch.title = title;
  const albumArtist = form.albumArtist.trim();
  if (albumArtist !== (album.artist_name ?? "")) {
    patch.album_artist = albumArtist;
  }
  const year = parseInt(form.year || "0", 10) || 0;
  if ((album.release_year ?? 0) !== year) patch.release_year = year;
  if (form.isCompilation !== album.is_compilation) {
    patch.is_compilation = form.isCompilation;
  }
  return patch;
}
