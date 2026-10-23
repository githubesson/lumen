import {
  albumArtUrl,
  displayText,
  pluralize,
  trackArtUrl,
  type ReplayData,
} from "@music-library/core";

/** What the Settings Replay row says about this year, from the Replay query. */
export interface ReplayTeaser {
  /** "<artist> on top", or null while there's nothing to say yet. */
  subtitle: string | null;
  /** Up to four cover URLs: the top albums', then top tracks' for any gap. */
  covers: string[];
}

export const REPLAY_TEASER_COVERS = 4;

/**
 * The row's subtitle and collage. Every list is read as optional, so an
 * older server's answer (or none, offline) still gives a plain row. TIDAL
 * albums have no library cover, so their slots go to the top tracks' art.
 */
export function replayTeaser(
  data: ReplayData | null | undefined,
  coverSize: number,
  limit = REPLAY_TEASER_COVERS,
): ReplayTeaser {
  if (!data) return { subtitle: null, covers: [] };
  const plays = data.summary?.total_plays ?? 0;
  if (plays <= 0) return { subtitle: "No plays yet this year", covers: [] };

  const topArtist = data.summary.headline_artist?.name ?? data.top_artists?.[0]?.name;
  const artist = topArtist ? displayText(topArtist) : "";
  const subtitle = artist
    ? `${artist} on top`
    : pluralize(plays, "play", undefined, { locale: true });

  const covers: string[] = [];
  const seen = new Set<string>();
  const add = (key: string, url: string | null) => {
    if (!url || seen.has(key) || covers.length >= limit) return;
    seen.add(key);
    covers.push(url);
  };
  for (const album of data.top_albums ?? []) add(album.id, albumArtUrl(album, coverSize));
  for (const track of data.top_tracks ?? []) {
    add(track.album_id || track.id, trackArtUrl(track, coverSize));
  }
  return { subtitle, covers };
}
