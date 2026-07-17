import { useCallback, useEffect, useRef } from "react";
import {
  getLatestPlaybackActivity,
  subscribePlaybackActivity,
} from "@music-library/core";
import {
  signAlbumCoverUrl,
  type PlaybackActivity,
  type TrackListItem,
} from "../api";
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
  const remoteActivityPushedRef = useRef(false);
  const remotePushGenerationRef = useRef(0);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  const pushRemoteActivity = useCallback(
    async (activity: PlaybackActivity | null) => {
      const generation = ++remotePushGenerationRef.current;
      if (currentRef.current) return;
      if (!activity) {
        if (remoteActivityPushedRef.current) {
          remoteActivityPushedRef.current = false;
          await clearDiscordActivity();
        }
        return;
      }

      const track = activityToTrack(activity);
      const coverUrl = await resolveSignedCoverUrl(
        track,
        coverUrlCacheRef.current,
      );
      if (
        generation !== remotePushGenerationRef.current ||
        currentRef.current
      ) {
        return;
      }
      remoteActivityPushedRef.current = true;
      await pushDiscordActivity({
        trackId: activity.track_id,
        title: activity.title,
        artist: activity.artist || undefined,
        album: activity.album || undefined,
        coverUrl,
        durationSec: activity.duration_sec,
        elapsedSec: activity.position_sec,
        isPlaying: activity.is_playing,
      });
    },
    [],
  );

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
      const remote = getLatestPlaybackActivity();
      if (remote) void pushRemoteActivity(remote);
      else if (!remoteActivityPushedRef.current) void clearDiscordActivity();
      return;
    }
    remotePushGenerationRef.current++;
    remoteActivityPushedRef.current = false;
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
  }, [current, pushRemoteActivity]);

  // The player-owned WebSocket publishes live snapshots from other signed-in
  // devices. Keep Discord mirrored while this desktop player is idle.
  useEffect(() => {
    if (!isElectron) return;
    return subscribePlaybackActivity((activity) => {
      void pushRemoteActivity(activity);
    });
  }, [pushRemoteActivity]);

  // Clear presence when the tab/app closes so users don't end up "listening"
  // to a ghost track forever.
  useEffect(() => {
    if (!isElectron) return;
    const onUnload = () => void clearDiscordActivity();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);
}

function activityToTrack(activity: PlaybackActivity): TrackListItem {
  return {
    id: activity.track_id,
    title: activity.title,
    artist: activity.artist,
    album_id: activity.album_id,
    album_title: activity.album,
    cover_url: activity.cover_url,
    duration_ms: (activity.duration_sec ?? 0) * 1000,
  };
}

/**
 * Resolve the cover URL to ship with a Discord activity push. Discord's media
 * proxy fetches `large_image` server-side without user cookies, so it can
 * only use public URLs: remote (TIDAL) covers arrive as the backend's authed
 * `/api/covers/remote?url=…` proxy path and must be unwrapped back to the
 * public CDN URL, while local covers need the signed backend path.
 *
 * Returns undefined when the track has no usable cover or signing failed;
 * Electron then falls back to the uploaded "lumen" asset
 * key on Discord's side.
 */
async function resolveSignedCoverUrl(
  track: TrackListItem,
  cache: Map<string, SignedCoverCacheEntry>,
): Promise<string | undefined> {
  if (track.cover_url) {
    const publicUrl = publicCoverUrl(track.cover_url);
    if (publicUrl) return publicUrl;
    // Same-origin authed path Discord can't fetch — fall through to the
    // signed album cover, or the Discord-side asset fallback.
  }
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

/**
 * Extract a publicly fetchable URL from a track's cover_url, or undefined if
 * there isn't one. The backend's `/api/covers/remote?url=…` proxy carries the
 * original CDN URL in its query string; other cross-origin URLs (e.g. raw
 * CDN links in activity rows written before the proxy existed) are already
 * public. Anything else same-origin is auth-gated and useless to Discord.
 */
function publicCoverUrl(coverUrl: string): string | undefined {
  const abs = toAbsolute(coverUrl);
  if (!abs) return undefined;
  try {
    const u = new URL(abs);
    if (u.pathname.endsWith("/api/covers/remote")) {
      return u.searchParams.get("url") ?? undefined;
    }
    if (u.origin !== window.location.origin) return abs;
    return undefined;
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
