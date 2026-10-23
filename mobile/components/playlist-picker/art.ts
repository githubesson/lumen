import { PixelRatio } from "react-native";
import { playlistArtUrl, trackArtUrl, type Playlist } from "@music-library/core";
import { downloadStore } from "../../lib/downloads";

/** Pixels for `size` points, the way CoverArt and PlaylistArtwork ask. */
function pixels(size: number) {
  return Math.max(1, Math.round(size * PixelRatio.get()));
}

/**
 * A track's cover at `size` points, preferring a downloaded copy on disk like
 * CoverArt does. The same size gives the same URI, so a view that shows it
 * again reuses the image already loaded.
 */
export function trackArtUri(
  track: { id: string; album_id?: string | null; has_cover?: boolean; cover_url?: string | null },
  size: number,
): string | null {
  return downloadStore.coverUriFor(track.id) ?? trackArtUrl(track, pixels(size));
}

/** A playlist's art at `size` points, as PlaylistArtwork requests it. */
export function playlistArtUri(playlist: Playlist, size: number): string | null {
  return playlistArtUrl(playlist, pixels(size));
}
