import { useEffect, useState } from "react";
import type { TrackListItem } from "@music-library/core";
import type { LyricsResult } from "../api";
import {
  fetchLyricsCached,
  lyricsCacheKey,
  peekLyricsCache,
} from "./lyricsCache";

/**
 * Lyrics for `track`, through the lyrics cache. Loads only while `enabled`,
 * so a closed lyrics view costs no request.
 */
export function useTrackLyrics(track: TrackListItem | null, enabled: boolean) {
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !track) {
      // Closing the view or clearing the external player track resets its
      // resource state before the next open.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLyrics(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const key = lyricsCacheKey(track);
    const cached = peekLyricsCache(key);

    if (cached) {
      if (cached.status === "hit") {
        setLyrics(cached.lyrics);
        setError(null);
      } else {
        setLyrics(null);
        setError("No lyrics found");
      }
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setLyrics(null);

    void fetchLyricsCached(track)
      .then((entry) => {
        if (cancelled) return;
        if (entry.status === "hit") {
          setLyrics(entry.lyrics);
          setError(null);
        } else {
          setLyrics(null);
          setError("No lyrics found");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to fetch lyrics:", err);
        setLyrics(null);
        setError("Failed to load lyrics");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, track]);

  return { lyrics, loading, error };
}

/** The track length the lyrics view times words against, in seconds. */
export function lyricsDurationSeconds(
  track: TrackListItem | null,
  playerDuration: number,
): number {
  if (track?.duration_ms != null) return track.duration_ms / 1000;
  return playerDuration > 0 ? playerDuration : 1;
}
