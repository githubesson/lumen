import type { DiscordActivityPayload } from "./contracts";
export type { DiscordActivityPayload } from "./contracts";

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

export function configureDiscordPresence(options: {
  clientId?: string;
  enabled?: boolean;
  backendUrl?: string;
}): void {
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
  if (connecting) return null;
  connecting = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RPC = require("discord-rpc");
    const nextClient = new RPC.Client({ transport: "ipc" });
    nextClient.on("ready", () => {
      console.log("[discord] connected as client", clientId);
    });
    nextClient.on("disconnected", () => {
      console.log("[discord] disconnected");
      client = null;
    });
    await nextClient.login({ clientId });
    client = nextClient;
    return nextClient;
  } catch (error) {
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
  const discord = await ensureDiscord();
  if (!discord) return { ok: false, error: "discord client unavailable" };
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
    return { ok: false, error: (error as Error).message };
  }
}

export async function clearDiscordActivity(): Promise<void> {
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
