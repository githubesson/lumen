import type { DiscordActivityPayload } from "../src/contracts/desktop";
export type { DiscordActivityPayload } from "../src/contracts/desktop";

// discord-rpc is CommonJS-only and intentionally loaded lazily.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordClient = any;

let client: DiscordClient | null = null;
let connecting = false;
let clientId = "";
let enabled = true;
let publicBackendUrl = "";
let lastActivity: DiscordActivityPayload | null = null;
let lastStartMs = 0;
let retryAfter = 0;
let failures = 0;
// The newest update Discord couldn't take (closed, or in reconnect backoff),
// resent once the backoff ends so presence recovers without a new event.
let retryActivity: { payload: DiscordActivityPayload; queuedAt: number } | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function cancelRetry(): void {
  retryActivity = null;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry(payload: DiscordActivityPayload): void {
  if (!enabled || !clientId) return;
  retryActivity = { payload, queuedAt: Date.now() };
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const pending = retryActivity;
    retryActivity = null;
    if (!pending) return;
    // A playing track has moved on while it waited.
    const waitedSec = (Date.now() - pending.queuedAt) / 1000;
    void pushDiscordActivity(
      pending.payload.isPlaying
        ? { ...pending.payload, elapsedSec: (pending.payload.elapsedSec ?? 0) + waitedSec }
        : pending.payload,
    );
  }, Math.max(1000, retryAfter - Date.now()));
  retryTimer.unref?.();
}

export function configureDiscordPresence(options: {
  clientId?: string;
  enabled?: boolean;
  backendUrl?: string;
}): void {
  if ((options.clientId !== undefined && clientId !== options.clientId.trim()) || (options.enabled === true && !enabled)) {
    retryAfter = 0;
    failures = 0;
  }
  if (options.clientId !== undefined) clientId = options.clientId.trim();
  if (options.backendUrl !== undefined) publicBackendUrl = options.backendUrl;
  if (options.enabled !== undefined) {
    const shouldDisconnect = enabled && !options.enabled;
    enabled = options.enabled;
    if (shouldDisconnect) void teardownDiscordPresence();
  }
}

async function ensureDiscord(): Promise<DiscordClient | null> {
  if (!enabled || !clientId) return null;
  if (client) return client;
  if (connecting || Date.now() < retryAfter) return null;
  connecting = true;
  let nextClient: DiscordClient | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RPC = require("discord-rpc");
    nextClient = new RPC.Client({ transport: "ipc" });
    nextClient.on("ready", () => {
      console.log("[discord] connected as client", clientId);
    });
    nextClient.on("disconnected", () => {
      console.log("[discord] disconnected");
      if (client === nextClient) {
        client = null;
        retryAfter = Math.max(retryAfter, Date.now() + 30_000);
      }
    });
    await nextClient.login({ clientId });
    if (!enabled) { await nextClient.destroy(); return null; }
    failures = 0;
    retryAfter = 0;
    client = nextClient;
    return nextClient;
  } catch (error) {
    retryAfter = Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(failures++, 4));
    try { await nextClient?.destroy(); } catch { /* Failed connections still need cleanup. */ }
    const message = (error as Error).message || String(error);
    if (message.includes("Cannot find module") && message.includes("discord-rpc")) {
      console.warn("[discord] `discord-rpc` package not installed — run `npm install`");
    } else {
      console.warn("[discord] connect failed:", message);
    }
    return null;
  } finally {
    connecting = false;
  }
}

function clampForDiscord(value: string | undefined, max = 128): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length < 2 ? `${trimmed} ` : trimmed.slice(0, max);
}

function discordCoverImage(coverUrl: string | undefined): string {
  const fallback = "lumen";
  if (!coverUrl) return fallback;
  if (!publicBackendUrl) return /^https:/i.test(coverUrl) ? coverUrl : fallback;
  try {
    const source = new URL(coverUrl);
    const isLoopback =
      source.hostname === "127.0.0.1" ||
      source.hostname === "localhost" ||
      source.hostname === "[::1]";
    const rewritten = isLoopback
      ? new URL(source.pathname + source.search, publicBackendUrl).toString()
      : source.toString();
    return /^https:/i.test(rewritten) ? rewritten : fallback;
  } catch {
    return fallback;
  }
}

export async function pushDiscordActivity(payload: DiscordActivityPayload): Promise<{
  ok: boolean;
  error?: string;
}> {
  // A newer update supersedes one waiting to be retried.
  cancelRetry();
  const discord = await ensureDiscord();
  if (!discord) {
    scheduleRetry(payload);
    return { ok: false, error: "discord client unavailable" };
  }
  try {
    const now = Date.now();
    const elapsedMs = Math.max(0, Math.floor((payload.elapsedSec ?? 0) * 1000));
    const startTimestamp = now - elapsedMs;
    const sameTrack =
      lastActivity &&
      payload.trackId !== undefined &&
      lastActivity.trackId === payload.trackId &&
      lastActivity.isPlaying;
    const seekedOrLooped =
      sameTrack && Math.abs(startTimestamp - lastStartMs) > 2500;
    const start =
      sameTrack && payload.isPlaying && lastStartMs > 0 && !seekedOrLooped
        ? lastStartMs
        : startTimestamp;
    const end =
      payload.isPlaying && payload.durationSec && payload.durationSec > 0
        ? start + Math.floor(payload.durationSec * 1000)
        : undefined;

    await discord.request("SET_ACTIVITY", {
      pid: process.pid,
      activity: {
        type: 2,
        details: clampForDiscord(payload.title) ?? "Music",
        state: clampForDiscord(payload.artist ?? payload.album),
        timestamps: payload.isPlaying
          ? {
              start: Math.floor(start / 1000),
              ...(end ? { end: Math.floor(end / 1000) } : {}),
            }
          : undefined,
        assets: {
          large_image: discordCoverImage(payload.coverUrl),
          large_text: clampForDiscord(payload.album),
          small_image: payload.isPlaying ? "play" : "pause",
          small_text: payload.isPlaying ? "Playing" : "Paused",
        },
        instance: false,
      },
    });
    lastActivity = payload;
    lastStartMs = start;
    return { ok: true };
  } catch (error) {
    scheduleRetry(payload);
    return { ok: false, error: (error as Error).message };
  }
}

export async function clearDiscordActivity(): Promise<void> {
  cancelRetry();
  if (!client) return;
  try {
    await client.clearActivity();
  } catch {
    // Discord may have exited between the renderer request and this call.
  }
  lastActivity = null;
  lastStartMs = 0;
}

export async function teardownDiscordPresence(): Promise<void> {
  cancelRetry();
  const current = client;
  client = null;
  lastActivity = null;
  lastStartMs = 0;
  if (!current) return;
  try {
    await current.clearActivity();
  } catch {
    // The socket may already be closed.
  }
  try {
    await current.destroy();
  } catch {
    // The socket may already be closed.
  }
}
