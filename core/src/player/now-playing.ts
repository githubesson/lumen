/**
 * What the OS media surfaces (lock screen, Control Center, CarPlay, Media
 * Session / Bluetooth controls) are told about local playback.
 */

import { trackCoverUrl, type TrackListItem } from "../api";
import { displayText } from "../format";

/**
 * Whether to keep an OS now-playing session for local playback.
 *
 * Pause is not a reason to drop the session. Music players leave the current
 * track published while paused so the OS can resume it. The session goes away
 * only when nothing is loaded locally, or while controlling another device:
 * the OS controls drive this device's audio, so a "play" from them would start
 * local playback next to the remote one.
 */
export function shouldExposeNowPlayingSession(opts: {
  hasTrack: boolean;
  isCasting: boolean;
}): boolean {
  return opts.hasTrack && !opts.isCasting;
}

/** Field names follow expo-audio's `AudioMetadata`; the web maps them to `MediaMetadata`. */
export interface NowPlayingMetadata {
  title: string;
  /** Omitted rather than empty when unknown; both OS APIs treat absent as blank. */
  artist?: string;
  albumTitle?: string;
  artworkUrl: string;
}

const NOW_PLAYING_ARTWORK_PX = 1024;

/** Metadata for the OS now-playing surfaces, or null with nothing loaded. */
export function buildNowPlayingMetadata(
  track: TrackListItem | null | undefined,
): NowPlayingMetadata | null {
  if (!track) return null;
  return {
    title: displayText(track.title),
    artist: displayText(track.artist) || undefined,
    albumTitle: displayText(track.album_title) || undefined,
    artworkUrl: trackCoverUrl(track, NOW_PLAYING_ARTWORK_PX),
  };
}
