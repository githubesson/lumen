import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  getBaseUrl,
  type PlaybackActivity,
  type PlaybackActivityInput,
  type TrackListItem,
} from "../api";
import type { Storage } from "../storage";
import type { AudioAdapter } from "./audio-adapter";
import type { PlayerState, TimeState } from "./player-core";

export const ACTIVITY_DEVICE_ID_STORAGE_KEY = "mlib-activity-device-id";

const PLAYBACK_SYNC_PROTOCOL = 1;
const PLAYING_HEARTBEAT_MS = 10_000;
const PAUSED_HEARTBEAT_MS = 30_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

type PlaybackActivityListener = (activity: PlaybackActivity | null) => void;

interface PlaybackSyncServerMessage {
  type: "activity.snapshot";
  protocol: number;
  activity: PlaybackActivity | null;
}

interface PlaybackSyncUpdateMessage {
  type: "activity.update";
  protocol: number;
  revision: number;
  activity: PlaybackActivityInput;
}

interface PlaybackSyncClearMessage {
  type: "activity.clear";
  protocol: number;
  revision: number;
  device_id: string;
}

const activityListeners = new Set<PlaybackActivityListener>();
let latestRemoteActivity: PlaybackActivity | null = null;
let hasRemoteSnapshot = false;

export interface PlaybackActivityPublisherOptions {
  state: PlayerState;
  time: TimeState;
  storage: Storage;
  deviceName: string;
  adapter?: Pick<AudioAdapter, "on">;
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

/** Subscribe to the freshest activity from another device in this runtime. */
export function subscribePlaybackActivity(
  listener: PlaybackActivityListener,
): () => void {
  activityListeners.add(listener);
  if (hasRemoteSnapshot) listener(latestRemoteActivity);
  return () => activityListeners.delete(listener);
}

/** Read the most recent server snapshot without waiting for another event. */
export function getLatestPlaybackActivity(): PlaybackActivity | null {
  return hasRemoteSnapshot ? latestRemoteActivity : null;
}

export function usePlaybackActivityPublisher({
  state,
  time,
  storage,
  deviceName,
  adapter,
  enabled = true,
}: PlaybackActivityPublisherOptions): string | null {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const stateRef = useRef(state);
  const timeRef = useRef(time);
  const socketRef = useRef<WebSocket | null>(null);
  const revisionRef = useRef(0);
  const publishedRef = useRef(false);
  const publishRef = useRef<() => void>(() => {});

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
    const revision = ++revisionRef.current;
    if (!payload) {
      if (!publishedRef.current) return;
      publishedRef.current = false;
      const sent = sendSocketMessage(socketRef.current, {
        type: "activity.clear",
        protocol: PLAYBACK_SYNC_PROTOCOL,
        revision,
        device_id: deviceId,
      });
      if (!sent) void api.clearPlaybackActivity(deviceId).catch(() => {});
      return;
    }

    publishedRef.current = true;
    const sent = sendSocketMessage(socketRef.current, {
      type: "activity.update",
      protocol: PLAYBACK_SYNC_PROTOCOL,
      revision,
      activity: payload,
    });
    // REST remains a compatibility path while the socket connects or when an
    // older deployment proxy does not yet support WebSocket upgrades.
    if (!sent) void api.upsertPlaybackActivity(payload).catch(() => {});
  }, [deviceId, deviceName, enabled]);

  publishRef.current = publish;

  useEffect(() => {
    if (!enabled || !deviceId) return;
    const endpoint = playbackSocketURL(deviceId);
    if (!endpoint) return;

    latestRemoteActivity = null;
    hasRemoteSnapshot = false;

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(endpoint);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) {
          socket.close(1000, "disposed");
          return;
        }
        attempt = 0;
        publishRef.current();
      };
      socket.onmessage = (event) => {
        const message = parseServerMessage(event.data);
        if (!message) return;
        latestRemoteActivity = message.activity;
        hasRemoteSnapshot = true;
        for (const listener of activityListeners) {
          try {
            listener(message.activity);
          } catch {
            // A platform integration must not break delivery to other
            // subscribers or the socket's reconnect lifecycle.
          }
        }
      };
      socket.onerror = () => {
        // onclose owns reconnect scheduling; browsers intentionally expose
        // very little detail for WebSocket handshake failures.
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        const exponential = Math.min(
          RECONNECT_MAX_MS,
          RECONNECT_BASE_MS * 2 ** attempt++,
        );
        const jittered = exponential * (0.75 + Math.random() * 0.5);
        retryTimer = setTimeout(connect, jittered);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (socketRef.current) {
        socketRef.current.close(1000, "player disposed");
        socketRef.current = null;
      }
      latestRemoteActivity = null;
      hasRemoteSnapshot = false;
    };
  }, [deviceId, enabled]);

  useEffect(() => {
    publish();
  }, [publish, state.current?.id, state.isPlaying]);

  useEffect(() => {
    if (!adapter) return;
    return adapter.on("seeked", publish);
  }, [adapter, publish]);

  useEffect(() => {
    if (!enabled || !deviceId || !state.current) return;
    const delay = state.isPlaying ? PLAYING_HEARTBEAT_MS : PAUSED_HEARTBEAT_MS;
    const interval = setInterval(publish, delay);
    return () => clearInterval(interval);
  }, [deviceId, enabled, publish, state.current, state.isPlaying]);

  useEffect(() => {
    return () => {
      if (deviceId && publishedRef.current) {
        // Socket teardown can race its closing handshake, so the REST delete
        // remains the best-effort unload cleanup. The server lease is the
        // authoritative fallback if the platform suspends networking first.
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

function sendSocketMessage(
  socket: WebSocket | null,
  message: PlaybackSyncUpdateMessage | PlaybackSyncClearMessage,
): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function parseServerMessage(data: unknown): PlaybackSyncServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as Partial<PlaybackSyncServerMessage>;
    if (
      parsed.type !== "activity.snapshot" ||
      parsed.protocol !== PLAYBACK_SYNC_PROTOCOL ||
      !(parsed.activity === null || typeof parsed.activity === "object")
    ) {
      return null;
    }
    return parsed as PlaybackSyncServerMessage;
  } catch {
    return null;
  }
}

function playbackSocketURL(deviceId: string): string | null {
  const configuredBase = getBaseUrl();
  const runtimeLocation = globalThis.location;
  const base = configuredBase || runtimeLocation?.origin;
  if (!base) return null;
  try {
    const endpoint = new URL("/api/activity/ws", base);
    if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
    else if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
    else return null;
    endpoint.searchParams.set("device_id", deviceId);
    return endpoint.toString();
  } catch {
    return null;
  }
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
