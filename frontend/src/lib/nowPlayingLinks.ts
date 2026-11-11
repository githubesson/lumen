import { api, isTidalTrack, resolveTrackAlbumTarget, type TrackListItem } from "@music-library/core";
import { artistHref } from "../components/TopArtist";

/** The album page a track opens, or null when it has none. */
export async function trackAlbumHref(track: TrackListItem): Promise<string | null> {
  const target = await resolveTrackAlbumTarget(track);
  if (!target) return null;
  const param = target.kind === "tidal" ? "tidalAlbum" : "album";
  return `/library?view=albums&${param}=${encodeURIComponent(target.id)}`;
}

/**
 * The page for one of a track's artists, by the name shown. A library track's
 * artists have library pages; a TIDAL track's (or a name the detail doesn't
 * list) open the artist search instead.
 */
export async function trackArtistHref(track: TrackListItem, name: string): Promise<string> {
  const search = `/library?view=artists&q=${encodeURIComponent(name)}`;
  if (isTidalTrack(track)) return search;
  const detail = await api.getTrack(track.id);
  const artist = detail.artists.find((a) => a.role !== "composer" && a.name === name);
  return artist ? artistHref(artist.id) : search;
}

/** The names in a track's comma-joined artist line. */
export function artistNames(artist: string | undefined): string[] {
  return (artist ?? "").split(", ").map((n) => n.trim()).filter(Boolean);
}
