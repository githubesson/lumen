import { useEffect, useState } from "react";

// Shared surface for the FH6 (Forza Horizon 6) radio bridge: the local HTTP
// bridge client, the snapshot types, and the window event that lets the
// FH6Radio page hand its polled bridge state to the MiniPlayer. Keeping these
// here means the page and the player can't drift apart on the wire format.

/** One track in the bridge's Lumen queue. */
export interface FH6QueueTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration_ms?: number;
}

/** `/api/state` payload (the subset Lumen reads). */
export interface FH6BridgeState {
  audio?: {
    active?: boolean;
    native_dsp_mode?: string;
    ring_avail?: number;
    underruns?: number;
  };
  sources?: {
    active?: string;
    available?: Array<{
      name: string;
      playback_state?: string;
      auth_state?: string;
      details?: {
        queue_count?: number;
        queue_mode?: string;
        username?: string;
        server_url?: string;
        last_error?: string;
      };
    }>;
  };
  track?: {
    title?: string;
    artist?: string;
    album?: string;
    duration_ms?: number;
    position_ms?: number;
  };
}

/** What the FH6Radio page publishes for the MiniPlayer to mirror. */
export interface FH6Snapshot {
  bridgeUrl: string;
  state: FH6BridgeState | null;
  queue?: FH6QueueTrack[];
  currentIndex?: number;
}

export const FH6_DEFAULT_BRIDGE_URL = "http://127.0.0.1:8420";

const SNAPSHOT_EVENT = "lumen:fh6-radio-state";

/** Broadcast the latest bridge snapshot (or `null` when leaving the page). */
export function publishFH6Snapshot(detail: FH6Snapshot | null) {
  window.dispatchEvent(new CustomEvent(SNAPSHOT_EVENT, { detail }));
}

/** Subscribe to the snapshot published by the FH6Radio page. */
export function useFH6Snapshot(): FH6Snapshot | null {
  const [snapshot, setSnapshot] = useState<FH6Snapshot | null>(null);
  useEffect(() => {
    const onSnapshot = (event: Event) => {
      setSnapshot((event as CustomEvent<FH6Snapshot | null>).detail);
    };
    window.addEventListener(SNAPSHOT_EVENT, onSnapshot);
    return () => window.removeEventListener(SNAPSHOT_EVENT, onSnapshot);
  }, []);
  return snapshot;
}

async function responseError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: string };
    return parsed.error ?? text;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

export async function bridgeGet<T>(bridgeUrl: string, path: string): Promise<T> {
  const res = await fetch(`${bridgeUrl}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(await responseError(res));
  return (await res.json()) as T;
}

export async function bridgePost(
  bridgeUrl: string,
  path: string,
  body?: unknown,
): Promise<void> {
  const res = await fetch(`${bridgeUrl}${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await responseError(res));
}

export async function bridgePut(
  bridgeUrl: string,
  path: string,
  body: unknown,
): Promise<void> {
  const res = await fetch(`${bridgeUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await responseError(res));
}

/**
 * Best-effort transport command (`play`, `pause`, `next`, `seek`, `jump`, …)
 * for the MiniPlayer mirror — network errors are swallowed because the next
 * snapshot poll reports the authoritative state anyway.
 */
export async function fh6Transport(
  bridgeUrl: string | undefined,
  action: string,
  body?: unknown,
) {
  if (!bridgeUrl) return;
  await bridgePost(bridgeUrl, `/api/source/lumen/${action}`, body).catch(() => {});
}
