import { lyricsContent, lyricsRequest } from "@music-library/core/lyrics";
import { api, type LyricsResult } from "../api";

export type LyricsCacheEntry =
  | { status: "hit"; lyrics: LyricsResult }
  | { status: "miss" };

const MAX_ENTRIES = 64;
const cache = new Map<string, LyricsCacheEntry>();
const inflight = new Map<string, Promise<LyricsCacheEntry>>();

export function lyricsCacheKey(track: {
  id: string;
  title: string;
  artist?: string;
  album_title?: string;
  duration_ms?: number;
}): string {
  return [
    track.id,
    track.title,
    track.artist ?? "",
    track.album_title ?? "",
    track.duration_ms ?? "",
  ].join("\0");
}

export function peekLyricsCache(key: string): LyricsCacheEntry | undefined {
  return cache.get(key);
}

function trimCache() {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function fetchLyricsCached(track: {
  id: string;
  title: string;
  artist?: string;
  album_title?: string;
  duration_ms?: number;
}): Promise<LyricsCacheEntry> {
  const key = lyricsCacheKey(track);
  const hit = cache.get(key);
  if (hit) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = api
    .getLyrics(lyricsRequest(track))
    // An instrumental result has no text but is still an answer; counting it
    // as a miss showed "No lyrics found" instead of "Instrumental".
    .then((result): LyricsCacheEntry =>
      lyricsContent(result).kind === "none"
        ? { status: "miss" }
        : { status: "hit", lyrics: result },
    )
    .then((entry) => {
      cache.set(key, entry);
      trimCache();
      return entry;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}
