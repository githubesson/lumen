import type { DiscordActivityPayload, DiscordCardOptions } from "../src/contracts/desktop";
import { DEFAULT_DISCORD_CARD, discordCardLines, discordStatusDisplayType } from "./discord-card";
export type { DiscordActivityPayload } from "../src/contracts/desktop";

// discord-rpc is CommonJS-only and intentionally loaded lazily.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordClient = any;

let client: DiscordClient | null = null;
let connecting = false;
let clientId = "";
let enabled = true;
let publicBackendUrl = "";
let card: DiscordCardOptions = DEFAULT_DISCORD_CARD;
let lastActivity: DiscordActivityPayload | null = null;
let lastStartMs = 0;
// The newest update asked for, confirmed by Discord or not. A card change
// redraws this one: `lastActivity` can still be the track a push in flight
// is replacing.
let requested: { payload: DiscordActivityPayload; at: number } | null = null;
let retryAfter = 0;
let failures = 0;
// The newest update Discord couldn't take (closed, or in reconnect backoff),
// resent once the backoff ends so presence recovers without a new event.
let retryActivity: { payload: DiscordActivityPayload; queuedAt: number } | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
// Bumped by every push and clear. A push that settles after a newer one
// started must neither queue a retry nor record itself as the activity.
let pushGeneration = 0;

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
    void pushDiscordActivity(movedOn(pending.payload, pending.queuedAt));
  }, Math.max(1000, retryAfter - Date.now()));
  retryTimer.unref?.();
}

/** `payload` as it stands now: a playing track has moved on since `sinceMs`. */
function movedOn(payload: DiscordActivityPayload, sinceMs: number): DiscordActivityPayload {
  if (!payload.isPlaying) return payload;
  return { ...payload, elapsedSec: (payload.elapsedSec ?? 0) + (Date.now() - sinceMs) / 1000 };
}

/** The last activity as it stands now, its elapsed time moved on if playing. */
function currentActivity(activity: DiscordActivityPayload): DiscordActivityPayload {
  return activity.isPlaying
    ? { ...activity, elapsedSec: Math.max(0, (Date.now() - lastStartMs) / 1000) }
    : activity;
}

export function configureDiscordPresence(options: {
  clientId?: string;
  enabled?: boolean;
  backendUrl?: string;
  card?: DiscordCardOptions;
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
  if (options.card && JSON.stringify(options.card) !== JSON.stringify(card)) {
    card = options.card;
    // Redraw what Discord shows now; the renderer only sends on player events.
    // A push still waiting to be retried picks the new card up when it goes.
    if (requested && !retryActivity) void pushDiscordActivity(movedOn(requested.payload, requested.at));
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
        // Steady playback sends no new updates, so reconnect after the
        // backoff and restore what Discord was showing.
        if (lastActivity) scheduleRetry(currentActivity(lastActivity));
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
  const generation = ++pushGeneration;
  requested = { payload, at: Date.now() };
  const discord = await ensureDiscord();
  // A newer push or a clear arrived while connecting: this one is stale.
  if (generation !== pushGeneration) return { ok: false, error: "superseded" };
  if (!discord) {
    scheduleRetry(payload);
    return { ok: false, error: "discord client unavailable" };
  }
  try {
    // Hidden while paused: clear the card, but remember the track so a card
    // change or a reconnect still knows what's loaded.
    if (!payload.isPlaying && !card.showPaused) {
      await discord.clearActivity();
      if (generation === pushGeneration) {
        lastActivity = payload;
        lastStartMs = 0;
      }
      return { ok: true };
    }
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

    const lines = discordCardLines(card, payload);
    await discord.request("SET_ACTIVITY", {
      pid: process.pid,
      activity: {
        type: 2,
        status_display_type: discordStatusDisplayType(card),
        details: lines.details,
        state: lines.state,
        timestamps: payload.isPlaying
          ? {
              start: Math.floor(start / 1000),
              ...(end ? { end: Math.floor(end / 1000) } : {}),
            }
          : undefined,
        assets: {
          large_image: card.cover ? discordCoverImage(payload.coverUrl) : "lumen",
          large_text: lines.largeText,
          ...(card.playState
            ? {
                small_image: payload.isPlaying ? "play" : "pause",
                small_text: payload.isPlaying ? "Playing" : "Paused",
              }
            : {}),
        },
        instance: false,
      },
    });
    if (generation === pushGeneration) {
      lastActivity = payload;
      lastStartMs = start;
    }
    return { ok: true };
  } catch (error) {
    if (generation === pushGeneration) scheduleRetry(payload);
    return { ok: false, error: (error as Error).message };
  }
}

export async function clearDiscordActivity(): Promise<void> {
  pushGeneration += 1;
  cancelRetry();
  // Forget the activity before awaiting: a disconnect during the clear
  // would otherwise queue it to be restored after the reconnect backoff.
  lastActivity = null;
  lastStartMs = 0;
  requested = null;
  if (!client) return;
  try {
    await client.clearActivity();
  } catch {
    // Discord may have exited between the renderer request and this call.
  }
  cancelRetry();
}

export async function teardownDiscordPresence(): Promise<void> {
  pushGeneration += 1;
  cancelRetry();
  const current = client;
  client = null;
  lastActivity = null;
  lastStartMs = 0;
  requested = null;
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
