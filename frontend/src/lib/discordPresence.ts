import { useEffect, useRef } from "react";
import { signAlbumCoverUrl, type TrackListItem } from "../api";
import { usePlayer, usePlayerAdapter } from "../context/Player";
import {
  clearDiscordActivity,
  isElectron,
  pushDiscordActivity,
} from "./platform";

interface SignedCoverCacheEntry {
  url: string;
  expiresAt: number; // unix seconds
}

/**
 * Push the currently playing track to Discord Rich Presence when running
 * inside Electron. No-ops in the browser build.
 *
 * Pushes happen on raw adapter events (`play`, `pause`, `seeked`, `ended`,
 * `loadedmetadata`) reading live `currentTime` / `duration` from the adapter,
 * so the embed updates the same frame the audio engine reacts. Avoids the
 * React-state round-trip and the 250 ms quantization in `usePlayerTime`.
 */
export function useDiscordPresence() {
  const { current } = usePlayer();
  const adapter = usePlayerAdapter();
  const currentRef = useRef<TrackListItem | null>(null);
  const coverUrlCacheRef = useRef<Map<string, SignedCoverCacheEntry>>(new Map());

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  // Push on every interesting adapter event. The adapter fires these directly
  // from the underlying audio element, so there's no quantization or rAF
  // delay between the user action and the Discord update.
  useEffect(() => {
    if (!isElectron) return;

    const push = (overrides?: { isPlaying?: boolean; elapsedSec?: number }) => {
      const track = currentRef.current;
      if (!track) return;
      const cover = coverUrlCacheRef.current;
      const trackId = track.id;
      const duration = adapter.duration() || 0;
      const elapsed =
        overrides?.elapsedSec ?? Math.max(0, adapter.currentTime());
      const isPlaying = overrides?.isPlaying ?? true;
      void (async () => {
        const coverUrl = await resolveSignedCoverUrl(track, cover);
        if (currentRef.current?.id !== trackId) return;
        await pushDiscordActivity({
          trackId,
          title: track.title,
          artist: track.artist ?? undefined,
          album: track.album_title ?? undefined,
          coverUrl,
          durationSec: duration > 0 ? duration : undefined,
          elapsedSec: Math.floor(elapsed),
          isPlaying,
        });
      })();
    };

    const offPlay = adapter.on("play", () => push({ isPlaying: true }));
    const offPause = adapter.on("pause", () => push({ isPlaying: false }));
    // `repeat:one` is handled by the core (ended → seek(0) → play), so the
    // loop reset reaches us via `seeked`. Non-loop track ends arrive as a
    // `current` change, which the track-change effect below handles.
    const offSeeked = adapter.on("seeked", () => push());
    const offMeta = adapter.on("loadedmetadata", () => push());

    return () => {
      offPlay();
      offPause();
      offSeeked();
      offMeta();
    };
  }, [adapter]);

  // Track changes: push a fresh activity (with elapsedSec=0 since the new
  // track hasn't started yet) and clear presence when nothing is playing.
  useEffect(() => {
    if (!isElectron) return;
    if (!current) {
      void clearDiscordActivity();
      return;
    }
    const trackId = current.id;
    void (async () => {
      const coverUrl = await resolveSignedCoverUrl(
        current,
        coverUrlCacheRef.current,
      );
      if (currentRef.current?.id !== trackId) return;
      await pushDiscordActivity({
        trackId,
        title: current.title,
        artist: current.artist ?? undefined,
        album: current.album_title ?? undefined,
        coverUrl,
        durationSec: undefined,
        elapsedSec: 0,
        isPlaying: true,
      });
    })();
  }, [current]);

  // Clear presence when the tab/app closes so users don't end up "listening"
  // to a ghost track forever.
  useEffect(() => {
    if (!isElectron) return;
    const onUnload = () => void clearDiscordActivity();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);
}

/**
 * Resolve the cover URL to ship with a Discord activity push. Discord's media
 * proxy fetches `large_image` server-side without the user's cookies, so the
 * normal auth-gated cover endpoints 404 on it. We ask the backend to mint a
 * short-lived signed public URL instead, cache it per album, and hand
 * Electron an absolute URL it can host-rewrite to the public backend.
 *
 * Returns undefined when the track has no album, the album has no cover, or
 * signing failed — Electron then falls back to the uploaded "lumen" asset
 * key on Discord's side.
 */
async function resolveSignedCoverUrl(
  track: TrackListItem,
  cache: Map<string, SignedCoverCacheEntry>,
): Promise<string | undefined> {
  if (!track.album_id) return undefined;
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = cache.get(track.album_id);
  // Refresh 10 minutes before expiry so a slow sign request doesn't leave us
  // shipping an already-expired URL.
  if (cached && cached.expiresAt - nowSec > 600) {
    return toAbsolute(cached.url);
  }
  try {
    const res = await signAlbumCoverUrl(track.album_id);
    cache.set(track.album_id, { url: res.url, expiresAt: res.expires_at });
    return toAbsolute(res.url);
  } catch {
    return undefined;
  }
}

function toAbsolute(relOrAbs: string): string | undefined {
  try {
    return new URL(relOrAbs, window.location.origin).toString();
  } catch {
    return undefined;
  }
}
