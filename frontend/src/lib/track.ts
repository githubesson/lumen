import type { TrackListItem } from "../api";

/**
 * A track stored in this library (as opposed to a streaming source like
 * TIDAL). Only local tracks can be edited, moved between albums, exported
 * as files, or shared as snippet links.
 */
export function isLocalTrack(track: TrackListItem): boolean {
  return !track.source || track.source === "local";
}
