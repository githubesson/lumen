import type { TrackListItem } from "./api";

/**
 * Predicates over a track's `source`. Shared so the two clients cannot answer
 * "can this be edited / shared?" differently: the web had these as named
 * helpers while the mobile app open-coded `track.source === "tidal"` at six
 * call sites, which is how a rule drifts without anyone noticing.
 */

/**
 * A track stored in this library (as opposed to a streaming source like
 * TIDAL). Only local tracks can be edited, moved between albums, or exported
 * as files.
 */
export function isLocalTrack(track: Pick<TrackListItem, "source">): boolean {
  return !track.source || track.source === "local";
}

/**
 * Snippet share links work for local tracks and TIDAL tracks. For TIDAL the
 * backend materializes a hidden track row on share, so the signed public
 * preview endpoints have a stable id to build the 30s MP4 from.
 */
export function canShareTrack(track: Pick<TrackListItem, "source">): boolean {
  return isLocalTrack(track) || track.source === "tidal";
}

/** A track whose album lives on the streaming source rather than in the library. */
export function isTidalTrack(track: Pick<TrackListItem, "source">): boolean {
  return track.source === "tidal";
}
