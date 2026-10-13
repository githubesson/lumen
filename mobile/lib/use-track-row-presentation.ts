import { displayText, type TrackListItem } from "@music-library/core";
import { useTrackUnavailableOffline } from "./offline-mode";

export interface TrackRowPresentation {
  title: string;
  artist: string;
  /** Under the title: the artist, or that the track is gone from TIDAL. */
  subtitle: string;
  /**
   * No longer on TIDAL and not in the library. A tap does nothing, so the row
   * ignores it and reads as disabled. A track that isn't downloaded while
   * offline stays tappable: the tap explains why it can't play.
   */
  removed: boolean;
  /** Fade the row: the track can't play here right now. */
  dimmed: boolean;
  accessibilityLabel: string;
  accessibilityHint: string | undefined;
}

/**
 * What a track row shows and tells VoiceOver, the same in every list: the
 * title and artist cleaned for display, faded when the track can't play here,
 * and a hint that says why. `menu` is whether press-and-hold opens the track
 * menu on this row.
 */
export function useTrackRowPresentation(
  track: TrackListItem,
  { menu = true }: { menu?: boolean } = {},
): TrackRowPresentation {
  const unavailableOffline = useTrackUnavailableOffline(track.id);
  const removed = !!track.unavailable;
  const title = displayText(track.title);
  const artist = displayText(track.artist);
  const label = artist ? `${title} by ${artist}` : title;
  const action = removed
    ? null
    : unavailableOffline
      ? "Not downloaded, so it can't play offline."
      : "Double tap to play.";
  const hint = [action, menu ? "Press and hold for more actions." : null]
    .filter(Boolean)
    .join(" ");
  return {
    title,
    artist,
    subtitle: removed ? "Removed from TIDAL" : artist,
    removed,
    dimmed: removed || unavailableOffline,
    accessibilityLabel: removed ? `${label}, removed from TIDAL` : label,
    accessibilityHint: hint || undefined,
  };
}
