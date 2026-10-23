import type { TrackListItem } from "@music-library/core";

let subject: TrackListItem | null = null;

/**
 * Hands the add-to-playlist picker the whole track before it's pushed: the
 * route carries only the id, and the picker's card shows the cover, names
 * and length without a fetch.
 */
export function setPlaylistPickerTrack(track: TrackListItem): void {
  subject = track;
}

/** The track handed over for `trackId`, if that's the one. */
export function playlistPickerTrack(
  trackId: string | undefined,
): TrackListItem | undefined {
  return subject && subject.id === trackId ? subject : undefined;
}
