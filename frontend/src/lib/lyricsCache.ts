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

  const durationSec = track.duration_ms
    ? Math.round(track.duration_ms / 1000)
    : undefined;

  const promise = api
    .getLyrics({
      track_name: track.title,
      artist_name: track.artist,
      album_name: track.album_title,
      duration: durationSec,
    })
    .then((result): LyricsCacheEntry => {
      if (result && (result.syncedLyrics || result.plainLyrics)) {
        return { status: "hit", lyrics: result };
      }
      return { status: "miss" };
    })
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
