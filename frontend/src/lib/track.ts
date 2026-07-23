import type { TrackListItem } from "../api";

/**
 * A track stored in this library (as opposed to a streaming source like
 * TIDAL). Only local tracks can be edited, moved between albums, or exported
 * as files.
 */
export function isLocalTrack(track: TrackListItem): boolean {
  return !track.source || track.source === "local";
}

/**
 * Snippet share links work for local tracks and TIDAL tracks. For TIDAL the
 * backend materializes a hidden track row on share, so the signed public
 * preview endpoints have a stable id to build the 30s MP4 from.
 */
export function canShareTrack(track: TrackListItem): boolean {
  return isLocalTrack(track) || track.source === "tidal";
}
