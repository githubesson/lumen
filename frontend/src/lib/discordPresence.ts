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
  const { current, isPlaying } = usePlayer();
  const adapter = usePlayerAdapter();
  const currentRef = useRef<TrackListItem | null>(null);
  const isPlayingRef = useRef(false);
  const coverUrlCacheRef = useRef<Map<string, SignedCoverCacheEntry>>(new Map());
  const remoteActivityPushedRef = useRef(false);
  const remoteActivityPendingRef = useRef(false);
  const remotePushGenerationRef = useRef(0);
  const pushLocalActivityRef = useRef<
    (overrides?: { isPlaying?: boolean; elapsedSec?: number }) => void
  >(() => {});

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const pushRemoteActivity = useCallback(
    async (activity: PlaybackActivity | null) => {
      const localTrack = currentRef.current;
      // A playing local player stays authoritative. A paused local player only
      // yields to a remote device that is actually playing; paused remote
      // heartbeats must not replace (or leave behind) its local status.
      if (
        localTrack &&
        (isPlayingRef.current || !activity?.is_playing)
      ) {
        if (
          remoteActivityPushedRef.current ||
          remoteActivityPendingRef.current
        ) {
          pushLocalActivityRef.current({
            isPlaying: isPlayingRef.current,
          });
        }
        return;
      }

      const generation = ++remotePushGenerationRef.current;
      remoteActivityPendingRef.current = !!activity;
      if (!activity) {
        remoteActivityPushedRef.current = false;
        await clearDiscordActivity();
        return;
      }

      const track = activityToTrack(activity);
      const coverUrl = await resolveSignedCoverUrl(
        track,
        coverUrlCacheRef.current,
      );
      if (
        generation !== remotePushGenerationRef.current ||
        (currentRef.current !== null &&
          (isPlayingRef.current || !activity.is_playing))
      ) {
        if (generation === remotePushGenerationRef.current) {
          remoteActivityPendingRef.current = false;
        }
        return;
      }
      remoteActivityPendingRef.current = false;
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
    if (!isElectron()) return;

    const pushLocal = (overrides?: {
      isPlaying?: boolean;
      elapsedSec?: number;
    }) => {
      const track = currentRef.current;
      if (!track) return;
      const generation = ++remotePushGenerationRef.current;
      remoteActivityPendingRef.current = false;
      remoteActivityPushedRef.current = false;
      const cover = coverUrlCacheRef.current;
      const trackId = track.id;
      const duration = adapter.duration() || 0;
      const elapsed =
        overrides?.elapsedSec ?? Math.max(0, adapter.currentTime());
      const isPlaying = overrides?.isPlaying ?? true;
      void (async () => {
        const coverUrl = await resolveSignedCoverUrl(track, cover);
        if (
          generation !== remotePushGenerationRef.current ||
          currentRef.current?.id !== trackId
        ) {
          return;
        }
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

    pushLocalActivityRef.current = pushLocal;
    const pushPreferred = (overrides: {
      isPlaying: boolean;
      elapsedSec?: number;
    }) => {
      isPlayingRef.current = overrides.isPlaying;
      const remote = getLatestPlaybackActivity();
      if (!overrides.isPlaying && remote?.is_playing) {
        void pushRemoteActivity(remote);
      } else {
        pushLocal(overrides);
      }
    };

    const offPlay = adapter.on("play", () =>
      pushPreferred({ isPlaying: true }),
    );
    const offPause = adapter.on("pause", () =>
      pushPreferred({ isPlaying: false }),
    );
    // `repeat:one` is handled by the core (ended → seek(0) → play), so the
    // loop reset reaches us via `seeked`. Non-loop track ends arrive as a
    // `current` change, which the track-change effect below handles.
    const offSeeked = adapter.on("seeked", () =>
      pushPreferred({ isPlaying: isPlayingRef.current }),
    );
    const offMeta = adapter.on("loadedmetadata", () =>
      pushPreferred({ isPlaying: isPlayingRef.current }),
    );

    return () => {
      pushLocalActivityRef.current = () => {};
      offPlay();
      offPause();
      offSeeked();
      offMeta();
    };
  }, [adapter, pushRemoteActivity]);

  // Track and local play-state changes re-evaluate which device owns presence.
  // A new local track starts at elapsedSec=0 until the adapter reports more.
  useEffect(() => {
    if (!isElectron()) return;
    if (!current) {
      void pushRemoteActivity(getLatestPlaybackActivity());
      return;
    }
    const remote = getLatestPlaybackActivity();
    if (!isPlaying && remote?.is_playing) {
      void pushRemoteActivity(remote);
    } else {
      pushLocalActivityRef.current({ isPlaying, elapsedSec: 0 });
    }
  }, [current, isPlaying, pushRemoteActivity]);

  // The player-owned WebSocket publishes live snapshots from other signed-in
  // devices. Keep Discord mirrored while this desktop player is not actively
  // playing, including when it still has a paused track loaded.
  useEffect(() => {
    if (!isElectron()) return;
    return subscribePlaybackActivity((activity) => {
      void pushRemoteActivity(activity);
    });
  }, [pushRemoteActivity]);

  // Clear presence when the tab/app closes so users don't end up "listening"
  // to a ghost track forever.
  useEffect(() => {
    if (!isElectron()) return;
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
