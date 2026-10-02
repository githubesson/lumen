import { api, searchEntityID } from "./api";
import type { ReplayAlbum, TrackDetail, TrackListItem, TrackSource } from "./api";
import type { RequestOptions } from "./api-transport";
import { isTidalTrack } from "./track";

/**
 * Which page an album or artist link opens: the library's own page (`id` is
 * the library id) or the TIDAL page (`id` is TIDAL's id, without the
 * `tidal:` prefix search results carry).
 */
export type EntityTarget = { kind: "local" | "tidal"; id: string };

type AlbumRef = Pick<TrackListItem, "source" | "album_id" | "source_album_id">;

/**
 * The album a track opens, from the row alone; null when the row doesn't say
 * (see {@link resolveTrackAlbumTarget}).
 *
 * A TIDAL track opens its TIDAL release even when it carries an `album_id`:
 * playing or sharing a TIDAL track stores a hidden copy of it under a hidden
 * album, and the library album routes only serve albums with visible tracks,
 * so that id would open a "not found" page.
 */
export function trackAlbumTarget(track: AlbumRef): EntityTarget | null {
  if (isTidalTrack(track)) {
    return track.source_album_id ? { kind: "tidal", id: track.source_album_id } : null;
  }
  return track.album_id ? { kind: "local", id: track.album_id } : null;
}

/**
 * {@link trackAlbumTarget}, falling back to the track's detail when the row
 * lacks the id (some list endpoints omit it). Null when the track has no
 * album; a failed detail read rejects.
 */
export async function resolveTrackAlbumTarget(
  track: AlbumRef & Pick<TrackListItem, "id">,
  options: RequestOptions = {},
): Promise<EntityTarget | null> {
  const target = trackAlbumTarget(track);
  if (target) return target;
  const detail: TrackDetail = await api.getTrack(track.id, options);
  // The row's source decides when it has one, as it does above.
  return trackAlbumTarget({
    source: track.source ?? detail.source,
    album_id: track.album_id || detail.album_id,
    source_album_id: track.source_album_id || detail.source_album_id,
  });
}

/**
 * Replay albums use a materialized local album id for artwork, even when all
 * of their plays came from TIDAL. Navigation needs the upstream album id in
 * that case; the local id points at hidden track rows and cannot open the
 * normal library album screen.
 */
export function replayAlbumTarget(album: ReplayAlbum): EntityTarget {
  if (album.source === "tidal" && album.source_album_id) {
    return { kind: "tidal", id: album.source_album_id };
  }
  return { kind: "local", id: album.id };
}

/**
 * The page a search result, artist release, or other album/artist payload
 * opens. A payload without a source is a library one.
 */
export function searchEntityTarget(item: {
  id: string;
  source?: TrackSource;
  source_id?: string;
}): EntityTarget {
  return item.source === "tidal"
    ? { kind: "tidal", id: searchEntityID(item) }
    : { kind: "local", id: item.id };
}
