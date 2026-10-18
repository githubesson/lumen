import * as http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DiscordActivityPayload } from "../src/contracts/desktop";

// A read-only HTTP API on loopback for stream overlays and other local tools:
// what's playing, its cover, and a stream of changes. It reports the same
// feed the renderer sends for Discord presence, so it follows the same
// rules about which device's playback counts. Every request carries a token
// (a query parameter, since <img> and EventSource can't send headers).

export const DEFAULT_NOW_PLAYING_PORT = 48638;

const MAX_TEXT = 512;
const MAX_URL = 4096;
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const COVER_TIMEOUT_MS = 10_000;
// Raster types only: an SVG opened straight from this origin could run script.
const COVER_TYPES = /^image\/(?:jpeg|png|webp|gif|avif)$/;

/** What GET /now-playing answers and each /events message carries. */
export interface NowPlayingSnapshot {
  playing: boolean;
  track: {
    id: string | null;
    title: string;
    artist: string | null;
    album: string | null;
    durationSec: number | null;
    /** Where playback is now, counted forward from the last update while playing. */
    positionSec: number;
    /** This server's /cover for the track, with the token, versioned so it reloads when the cover changes. */
    coverUrl: string | null;
  } | null;
}

type Cover = { type: string; body: Buffer };

export interface NowPlayingServer {
  /** The API's origin while it listens, otherwise "". */
  readonly url: string;
  /** Why the last start failed, until it listens or is turned off. */
  readonly error: string;
  /** What every request must carry; a new one cuts off open event streams. */
  token: string;
  start(port: number): Promise<void>;
  close(): void;
  /** The track to report, or null when nothing is loaded. */
  update(activity: DiscordActivityPayload | null): void;
}

/** A port from config.json, or the default when it's missing or invalid. */
export function nowPlayingPort(raw: unknown): number {
  return Number.isInteger(raw) && (raw as number) > 0 && (raw as number) <= 65535
    ? (raw as number)
    : DEFAULT_NOW_PLAYING_PORT;
}

/** A token from config.json, or "" when it's missing or unusable. */
export function nowPlayingToken(raw: unknown): string {
  return typeof raw === "string" && /^[\w-]{16,256}$/.test(raw) ? raw : "";
}

export function newNowPlayingToken(): string {
  return randomBytes(24).toString("base64url");
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function seconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The renderer's payload with only the fields and types this API reports. */
function clean(activity: DiscordActivityPayload): DiscordActivityPayload {
  return {
    trackId: text(activity.trackId),
    title: text(activity.title) ?? "",
    artist: text(activity.artist),
    album: text(activity.album),
    coverUrl: text(activity.coverUrl, MAX_URL),
    durationSec: seconds(activity.durationSec),
    elapsedSec: seconds(activity.elapsedSec),
    isPlaying: activity.isPlaying === true,
  };
}

function listenError(error: NodeJS.ErrnoException, port: number): string {
  if (error.code === "EADDRINUSE") return `Port ${port} is in use by another app.`;
  if (error.code === "EACCES") return `Lumen isn't allowed to use port ${port}.`;
  return `Couldn't start on port ${port}: ${error.message}`;
}

// Any page with the token may read what's playing (overlays are often hosted
// elsewhere). Nothing here changes state, and none of it carries a session.
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};

export function createNowPlayingServer(options: {
  /** Fetches a cover; the main process passes Electron's net.fetch. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The local app proxy's origin, which serves signed library covers. */
  appOrigin: () => string;
}): NowPlayingServer {
  let server: http.Server | null = null;
  let starting: { port: number; done: Promise<void> } | null = null;
  // Bumped by close, so a listen that finishes after it isn't adopted.
  let generation = 0;
  let port = 0;
  let error = "";
  let token = "";
  let current: { activity: DiscordActivityPayload; at: number } | null = null;
  let cover: { identity: string; load: Promise<Cover | null> } | null = null;
  const streams = new Set<ServerResponse>();

  const origin = () => (port ? `http://127.0.0.1:${port}` : "");

  // A page on another hostname that resolves to 127.0.0.1 (DNS rebinding)
  // sends its own name as Host, so only loopback names are answered.
  function isAllowedHost(req: IncomingMessage): boolean {
    const host = req.headers.host?.toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  // From ?token= or an Authorization: Bearer header.
  function isAuthorized(req: IncomingMessage, query: URLSearchParams): boolean {
    if (!token) return false;
    const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const given = Buffer.from(query.get("token") || bearer || "");
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** The app's signed cover path without its signature, which changes when
   *  the renderer re-signs; any other source as it is. */
  function coverIdentity(source: string): string {
    try {
      const url = new URL(source);
      if (url.origin === options.appOrigin() && url.pathname.startsWith("/api/public/covers/")) {
        return url.origin + url.pathname;
      }
    } catch {
      // Not a URL: never fetched, so its identity doesn't matter.
    }
    return source;
  }

  function snapshot(now = Date.now()): NowPlayingSnapshot {
    if (!current) return { playing: false, track: null };
    const { activity, at } = current;
    const duration = activity.durationSec && activity.durationSec > 0 ? activity.durationSec : null;
    let position = (activity.elapsedSec ?? 0) + (activity.isPlaying ? (now - at) / 1000 : 0);
    if (duration !== null) position = Math.min(position, duration);
    const version = activity.coverUrl
      ? createHash("sha256").update(coverIdentity(activity.coverUrl)).digest("hex").slice(0, 12)
      : null;
    return {
      playing: activity.isPlaying,
      track: {
        id: activity.trackId ?? null,
        title: activity.title,
        artist: activity.artist ?? null,
        album: activity.album ?? null,
        durationSec: duration,
        positionSec: Math.round(position * 1000) / 1000,
        coverUrl: version ? `${origin()}/cover?v=${version}&token=${encodeURIComponent(token)}` : null,
      },
    };
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...HEADERS, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  // Covers come over https from a CDN, or as a signed path on the app's own
  // proxy (see the renderer's resolveSignedCoverUrl). Nothing else is fetched.
  function coverAllowed(source: string): boolean {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return false;
    }
    if (url.protocol === "https:") return true;
    const app = options.appOrigin();
    return !!app && url.origin === app && url.pathname.startsWith("/api/public/covers/");
  }

  async function fetchCover(source: string): Promise<Cover | null> {
    if (!coverAllowed(source)) return null;
    const response = await options.fetch(source, {
      credentials: "omit",
      // A redirect could lead anywhere the rule above doesn't allow; neither
      // TIDAL's CDN nor the server's cover paths redirect.
      redirect: "error",
      signal: AbortSignal.timeout(COVER_TIMEOUT_MS),
    });
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!response.ok || !COVER_TYPES.test(type) || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_COVER_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return { type, body: Buffer.concat(chunks) };
  }

  /** The current track's cover, fetched once and kept until the cover changes. */
  function currentCover(): Promise<Cover | null> {
    const source = current?.activity.coverUrl;
    if (!source) return Promise.resolve(null);
    const identity = coverIdentity(source);
    if (cover?.identity !== identity) {
      const load = fetchCover(source).catch(() => null);
      cover = { identity, load };
      // Try again on the next request rather than keeping a failure.
      void load.then((result) => {
        if (!result && cover?.load === load) cover = null;
      });
    }
    return cover.load;
  }

  async function serveCover(res: ServerResponse): Promise<void> {
    const image = await currentCover();
    if (!image) {
      sendJson(res, 404, { error: "No cover" });
      return;
    }
    res.writeHead(200, { ...HEADERS, "Content-Type": image.type, "Content-Length": image.body.length });
    res.end(image.body);
  }

  function serveEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { ...HEADERS, "Content-Type": "text/event-stream; charset=utf-8" });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    streams.add(res);
    res.on("close", () => streams.delete(res));
  }

  // Nothing a request does may throw out of the server: in the main process
  // that's an error dialog.
  function handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      route(req, res);
    } catch (cause) {
      fail(res, cause);
    }
  }

  function fail(res: ServerResponse, cause: unknown): void {
    console.warn("[now-playing]", (cause as Error).message);
    if (res.headersSent) res.destroy();
    else sendJson(res, 500, { error: "Internal error" });
  }

  function route(req: IncomingMessage, res: ServerResponse): void {
    if (!isAllowedHost(req)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...HEADERS,
        "Access-Control-Allow-Methods": "GET, HEAD",
        // A wildcard alone doesn't cover Authorization.
        "Access-Control-Allow-Headers": "Authorization, *",
        // Chrome asks before a public page reads a loopback server.
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD, OPTIONS");
      sendJson(res, 405, { error: "Read only" });
      return;
    }
    let url: URL;
    try {
      // A path like "//" doesn't parse.
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJson(res, 400, { error: "Bad request" });
      return;
    }
    const { pathname: path, searchParams } = url;
    if (!isAuthorized(req, searchParams)) {
      sendJson(res, 401, { error: "Missing or wrong token" });
      return;
    }
    if (path === "/now-playing") sendJson(res, 200, snapshot());
    else if (path === "/cover") serveCover(res).catch((cause) => fail(res, cause));
    else if (path === "/events") serveEvents(req, res);
    else sendJson(res, 404, { error: "Not found" });
  }

  function endStreams(): void {
    for (const stream of streams) stream.end();
    streams.clear();
  }

  function close(): void {
    generation += 1;
    starting = null;
    endStreams();
    if (server) {
      server.close();
      server.closeAllConnections();
    }
    server = null;
    port = 0;
    error = "";
  }

  return {
    get url() {
      return origin();
    },
    get error() {
      return error;
    },
    get token() {
      return token;
    },
    set token(next) {
      if (next === token) return;
      token = next;
      endStreams();
    },
    start(wanted) {
      if (server && port === wanted) return Promise.resolve();
      if (starting?.port === wanted) return starting.done;
      close();
      const id = generation;
      const done: Promise<void> = new Promise<void>((resolve, reject) => {
        const next = http.createServer(handle);
        next.once("error", (cause: NodeJS.ErrnoException) => {
          const message = listenError(cause, wanted);
          if (id === generation) error = message;
          reject(new Error(message));
        });
        next.listen(wanted, "127.0.0.1", () => {
          if (id !== generation) {
            next.close();
            reject(new Error("It was turned off before it started."));
            return;
          }
          // Later socket errors aren't listen failures.
          next.removeAllListeners("error");
          next.on("error", (cause) => console.warn("[now-playing]", cause.message));
          server = next;
          port = wanted;
          error = "";
          resolve();
        });
      }).finally(() => {
        if (starting?.done === done) starting = null;
      });
      starting = { port: wanted, done };
      return done;
    },
    close,
    update(activity) {
      current = activity ? { activity: clean(activity), at: Date.now() } : null;
      if (streams.size === 0) return;
      const message = `data: ${JSON.stringify(snapshot())}\n\n`;
      for (const stream of streams) stream.write(message);
    },
  };
}
