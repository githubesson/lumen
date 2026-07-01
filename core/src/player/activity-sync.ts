import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PlaybackActivityInput, type TrackListItem } from "../api";
import type { Storage } from "../storage";
import type { PlayerState, TimeState } from "./player-core";

export const ACTIVITY_DEVICE_ID_STORAGE_KEY = "mlib-activity-device-id";

const PLAYING_HEARTBEAT_MS = 10_000;
const PAUSED_HEARTBEAT_MS = 30_000;

export interface PlaybackActivityPublisherOptions {
  state: PlayerState;
  time: TimeState;
  storage: Storage;
  deviceName: string;
  enabled?: boolean;
}

export async function getOrCreateActivityDeviceId(
  storage: Storage,
): Promise<string> {
  const existing = await storage.getItem(ACTIVITY_DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;
  const next = createDeviceId();
  await storage.setItem(ACTIVITY_DEVICE_ID_STORAGE_KEY, next);
  return next;
}

export function usePlaybackActivityPublisher({
  state,
  time,
  storage,
  deviceName,
  enabled = true,
}: PlaybackActivityPublisherOptions): string | null {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const stateRef = useRef(state);
  const timeRef = useRef(time);
  const publishedRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    timeRef.current = time;
  }, [time]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getOrCreateActivityDeviceId(storage).then((id) => {
      if (!cancelled) setDeviceId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, storage]);

  const publish = useCallback(() => {
    if (!enabled || !deviceId) return;
    const payload = buildActivityPayload(
      deviceId,
      deviceName,
      stateRef.current.current,
      stateRef.current.isPlaying,
      timeRef.current,
    );
    if (!payload) {
      if (publishedRef.current) {
        publishedRef.current = false;
        void api.clearPlaybackActivity(deviceId).catch(() => {});
      }
      return;
    }
    publishedRef.current = true;
    void api.upsertPlaybackActivity(payload).catch(() => {});
  }, [deviceId, deviceName, enabled]);

  useEffect(() => {
    publish();
  }, [publish, state.current?.id, state.isPlaying]);

  useEffect(() => {
    if (!enabled || !deviceId || !state.current) return;
    const delay = state.isPlaying ? PLAYING_HEARTBEAT_MS : PAUSED_HEARTBEAT_MS;
    const interval = setInterval(publish, delay);
    return () => clearInterval(interval);
  }, [deviceId, enabled, publish, state.current, state.isPlaying]);

  useEffect(() => {
    return () => {
      if (deviceId && publishedRef.current) {
        void api.clearPlaybackActivity(deviceId).catch(() => {});
      }
    };
  }, [deviceId]);

  return deviceId;
}

function buildActivityPayload(
  deviceId: string,
  deviceName: string,
  track: TrackListItem | null,
  isPlaying: boolean,
  time: TimeState,
): PlaybackActivityInput | null {
  if (!track) return null;
  const durationSec =
    time.duration > 0
      ? Math.round(time.duration)
      : Math.round((track.duration_ms || 0) / 1000);
  return {
    device_id: deviceId,
    device_name: deviceName,
    track_id: track.id,
    title: track.title,
    artist: track.artist || undefined,
    album: track.album_title || undefined,
    album_id: track.album_id || undefined,
    cover_url: track.cover_url || undefined,
    duration_sec: durationSec > 0 ? durationSec : undefined,
    position_sec: Math.max(0, Math.floor(time.currentTime || 0)),
    is_playing: isPlaying,
  };
}

function createDeviceId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && "randomUUID" in cryptoObj) {
    return cryptoObj.randomUUID();
  }
  return `device-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}
