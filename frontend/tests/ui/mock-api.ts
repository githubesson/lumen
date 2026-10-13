// Serves the Go backend's API from fixtures, so the UI lint run needs no
// server, database or music. Requests nothing here answers are logged (see
// `unmocked`) and get an empty response.
import { expect, type Page, type Route, type TestInfo } from "playwright/test";
import type { PlaybackActivity, Playlist, ReplayBucket } from "@music-library/core/api";
import * as data from "./fixtures";

type Reply =
  | { json: unknown; status?: number; headers?: Record<string, string> }
  | { body: string | Buffer; contentType: string; status?: number; headers?: Record<string, string> }
  | { status: number; text?: string };

type Handler = (match: RegExpMatchArray, url: URL, route: Route) => Reply | null;

export interface MockOptions {
  signedIn: boolean;
}

/** Calls the mock had no fixture for, per test. Checked by `expectAllMocked`. */
const unmockedByPage = new WeakMap<Page, string[]>();

export async function mockApi(page: Page, { signedIn }: MockOptions): Promise<void> {
  const unmocked: string[] = [];
  unmockedByPage.set(page, unmocked);
  const routes = apiRoutes(signedIn);

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method() === "HEAD" ? "GET" : request.method();
      for (const [verb, pattern, handler] of routes) {
        if (verb !== method) continue;
        const match = url.pathname.match(pattern);
        if (!match) continue;
        const reply = handler(match, url, route);
        if (reply) return fulfill(route, reply);
      }
      unmocked.push(`${request.method()} ${url.pathname}${url.search}`);
      // A sensible nothing: an empty list for reads, no content for writes.
      return fulfill(route, method === "GET" ? { json: [] } : { status: 204 });
    },
  );

  // Backend-rendered pages (share cards, embeds) are not part of this app.
  await page.route(
    (url) => url.pathname.startsWith("/share/") || url.pathname.startsWith("/embed/"),
    (route) => {
      unmocked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ status: 404, body: "not found" });
    },
  );

  // Keep the run offline: answer GitHub's release lookup, refuse the rest.
  await page.route(
    (url) => url.hostname !== "localhost" && url.protocol.startsWith("http"),
    (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "api.github.com" && url.pathname.endsWith("/releases/latest")) {
        return route.fulfill({
          json: { tag_name: "v0.1.14", html_url: "https://github.com/githubesson/lumen/releases/tag/v0.1.14", assets: [] },
        });
      }
      unmocked.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    },
  );

  // The player's device socket: answer the hello with this device alone, so
  // the device picker shows a settled list.
  await page.routeWebSocket(/\/api\/activity\/ws/, (ws) => {
    const deviceId = new URL(ws.url()).searchParams.get("device_id") ?? "web";
    ws.onMessage((message) => {
      let parsed: { type?: string; device_name?: string; capabilities?: string[]; control_enabled?: boolean };
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (parsed.type !== "device.hello") return;
      ws.send(JSON.stringify({ type: "activity.snapshot", protocol: 1, activity: null }));
      ws.send(
        JSON.stringify({
          type: "devices.snapshot",
          protocol: 1,
          devices: [
            {
              device_id: deviceId,
              device_name: parsed.device_name ?? "Web",
              online: true,
              control_enabled: parsed.control_enabled ?? true,
              capabilities: parsed.capabilities ?? [],
              connected_at: new Date().toISOString(),
              activity: null,
            },
          ],
        }),
      );
    });
  });
}

/** Prints and attaches the calls this test made that the mock didn't know. */
/**
 * Fails the test, softly so lintapple still runs, for API calls no fixture
 * answered: the screen would show an empty or error state instead of the UI
 * under test.
 */
export function expectAllMocked(page: Page, testInfo: TestInfo): void {
  const calls = [...new Set(unmockedByPage.get(page) ?? [])];
  for (const call of calls) testInfo.annotations.push({ type: "unmocked", description: call });
  expect.soft(calls, "API calls without a fixture in tests/ui/mock-api.ts").toEqual([]);
}

function fulfill(route: Route, reply: Reply) {
  if ("json" in reply) return route.fulfill({ status: reply.status ?? 200, json: reply.json, headers: reply.headers });
  if ("body" in reply) {
    return route.fulfill({
      status: reply.status ?? 200,
      body: reply.body,
      contentType: reply.contentType,
      headers: { "Cache-Control": "max-age=3600", ...reply.headers },
    });
  }
  return route.fulfill({ status: reply.status, body: reply.text ?? "", contentType: "text/plain" });
}

function paged<T>(items: T[], url: URL): Reply {
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  return { json: items.slice(offset, offset + limit), headers: { "X-Total-Count": String(items.length) } };
}

const notFound: Reply = { status: 404, text: "not found" };
const noContent: Reply = { status: 204 };

function apiRoutes(signedIn: boolean): [string, RegExp, Handler][] {
  const id = "([^/]+)";
  const track = (raw: string) => data.tracks.find((t) => t.id === decodeURIComponent(raw));
  const playlist = (raw: string): Playlist | undefined => data.playlists.find((p) => p.id === raw);
  const sortedTracks = (sort: string | null) => {
    const rows = data.tracks.map(data.listItem);
    const by = (key: (t: (typeof rows)[number]) => string | number) =>
      [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    switch (sort) {
      case "title": return by((t) => t.title);
      case "artist": return by((t) => t.artist ?? "");
      case "album": return by((t) => t.album_title ?? "");
      case "duration": return by((t) => t.duration_ms);
      default: return rows;
    }
  };

  return [
    // Auth
    ["GET", /^\/api\/auth\/me$/, () => (signedIn ? { json: data.me } : { status: 401, text: "unauthorized" })],
    ["GET", /^\/api\/auth\/invite$/, () => ({ json: { valid: true, target_role: "user" } })],
    ["POST", /^\/api\/auth\/logout$/, () => noContent],

    // Library
    ["GET", /^\/api\/tracks$/, (_m, url) => paged(sortedTracks(url.searchParams.get("sort")), url)],
    ["GET", new RegExp(`^/api/tracks/${id}/cover$`), (m) => cover(m[1])],
    ["GET", new RegExp(`^/api/tracks/${id}/stream$`), (m) => {
      const t = track(m[1]);
      return t ? { body: silentWav(t.duration_ms / 1000), contentType: "audio/wav" } : notFound;
    }],
    ["GET", new RegExp(`^/api/tracks/${id}$`), (m) => {
      const t = track(m[1]);
      return t ? { json: data.trackDetail(t) } : notFound;
    }],
    ["POST", new RegExp(`^/api/tracks/${id}/(play|scrobble|now-playing|favorite)$`), () => noContent],
    ["DELETE", new RegExp(`^/api/tracks/${id}/favorite$`), () => noContent],
    ["POST", new RegExp(`^/api/tracks/${id}/share$`), (m, url) => ({
      json: {
        url: `${url.origin}/share/track/${m[1]}?t=${url.searchParams.get("t") ?? 0}&d=30&sig=4b1d9e`,
        start_sec: Number(url.searchParams.get("t") ?? 0),
        duration_sec: Number(url.searchParams.get("d") ?? 30),
      },
    })],
    ["GET", /^\/api\/albums$/, (_m, url) => paged(data.albums, url)],
    ["GET", new RegExp(`^/api/albums/${id}/cover$`), (m) => cover(m[1])],
    ["GET", new RegExp(`^/api/albums/${id}/tracks$`), (m) => ({ json: data.tracks.filter((t) => t.album_id === m[1]).map(data.listItem) })],
    ["GET", new RegExp(`^/api/albums/${id}$`), (m) => {
      const album = data.albums.find((a) => a.id === m[1]);
      // Every fixture album artist has library tracks, so a page.
      return album ? { json: { ...album, artist_has_page: true } } : notFound;
    }],
    ["GET", new RegExp(`^/api/tidal/albums/${id}$`), (m) => {
      const album = data.tidalAlbums.find((a) => a.id === m[1]);
      return album ? { json: album } : notFound;
    }],
    ["GET", /^\/api\/artists$/, (_m, url) => paged(data.artists, url)],
    ["GET", new RegExp(`^/api/artists/${id}/tracks$`), (m) => ({ json: data.artistTracks(m[1]).map(data.listItem) })],
    ["GET", new RegExp(`^/api/artists/${id}$`), (m) => {
      const artist = data.artists.find((a) => a.id === m[1]);
      return artist ? { json: artist } : notFound;
    }],
    ["GET", /^\/api\/search$/, (_m, url) => ({ json: data.search(url.searchParams.get("q") ?? "", url.searchParams.get("type") ?? "all") })],
    ["GET", /^\/api\/covers\/remote$/, (_m, url) => cover(url.searchParams.get("url") ?? "remote")],
    ["GET", /^\/api\/covers\/sign$/, (_m, url) => ({
      json: { url: `${url.origin}/api/public/covers/album/${url.searchParams.get("album_id")}?sig=4b1d9e`, expires_at: 1_792_540_800 },
    })],
    ["GET", /^\/api\/lyrics$/, (_m, url) => {
      const t = data.tracks.find((row) => row.title === url.searchParams.get("track_name")) ?? data.tracks[0];
      return { json: url.searchParams.has("q") ? [data.lyrics(t)] : data.lyrics(t) };
    }],

    // Listening
    ["GET", /^\/api\/favorites$/, (_m, url) => ({ json: Number(url.searchParams.get("offset") ?? 0) > 0 ? [] : data.favorites })],
    ["GET", /^\/api\/recent$/, (_m, url) => ({ json: data.recent.slice(0, Number(url.searchParams.get("limit") ?? 100)) })],
    ["GET", /^\/api\/stats\/replay$/, (_m, url) => ({
      json: data.replay(
        (url.searchParams.get("bucket") ?? "day") as ReplayBucket,
        url.searchParams.get("from"),
        url.searchParams.get("to"),
      ),
    })],
    ["GET", /^\/api\/activity\/current$/, () => ({ json: { activity: null } })],
    ["PUT", /^\/api\/activity$/, (_m, _url, route) => ({
      json: { ...(route.request().postDataJSON() as PlaybackActivity), updated_at: new Date().toISOString() },
    })],
    ["DELETE", new RegExp(`^/api/activity/${id}$`), () => noContent],
    ["GET", /^\/api\/integrations\/lastfm$/, () => ({ json: data.lastfm })],

    // Playlists
    ["GET", /^\/api\/playlists$/, () => ({ json: data.playlists })],
    ["GET", /^\/api\/playlists\/invites$/, () => ({ json: data.pendingInvites })],
    ["GET", new RegExp(`^/api/playlists/${id}/tracks$`), (m) => {
      if (!playlist(m[1])) return notFound;
      return { json: { tracks: data.playlistTracks(m[1]), tidal_queued: 0 }, headers: { ETag: `"${m[1]}-v1"` } };
    }],
    ["GET", new RegExp(`^/api/playlists/${id}/collaborators$`), (m) => ({ json: data.collaborators[m[1]] ?? [] })],
    ["GET", new RegExp(`^/api/playlists/${id}/cover$`), (m) => cover(m[1])],
    ["GET", new RegExp(`^/api/playlists/${id}$`), (m) => {
      const p = playlist(m[1]);
      if (!p) return notFound;
      const { cover: _cover, ...detail } = p;
      return { json: detail };
    }],

    // Admin
    ["GET", /^\/api\/admin\/users$/, () => ({ json: data.adminUsers })],
    ["GET", /^\/api\/admin\/invites$/, () => ({ json: data.invites })],
    ["GET", /^\/api\/admin\/library\/roots$/, () => ({ json: data.musicRoots })],
    ["GET", /^\/api\/admin\/library\/roots\/usage$/, () => ({ json: data.musicRootUsage })],
    ["GET", /^\/api\/admin\/library\/errors$/, () => ({ json: data.ingestErrors })],
    ["GET", /^\/api\/admin\/library\/rescan$/, () => ({ json: data.rescanStatus })],
    ["GET", /^\/api\/admin\/library\/artistgrid\/pins$/, () => ({ json: data.artistGridPins })],
    ["GET", /^\/api\/admin\/library\/filen\/pins$/, () => ({ json: data.filenPins })],
    ["GET", /^\/api\/admin\/library\/api-trackers\/pins$/, () => ({ json: data.apiTrackerPins })],
    ["GET", /^\/api\/admin\/library\/(artistgrid|filen|api-trackers)\/pins\/[^/]+\/downloads$/, () => ({ json: [] })],
    ["GET", /^\/api\/admin\/tidal\/status$/, () => ({ json: data.tidalStatus })],
    ["GET", /^\/api\/admin\/tidal\/auto-download$/, () => ({ json: data.tidalAutoDownload })],

    // Public share page
    ["GET", new RegExp(`^/api/public/share/track/${id}$`), (m, url) => {
      const share = data.publicShare(url.origin, decodeURIComponent(m[1]), Number(url.searchParams.get("t") ?? 0));
      return share ? { json: share } : notFound;
    }],
    ["GET", new RegExp(`^/api/public/covers/album/${id}$`), (m) => cover(m[1])],
    // Preview media is rendered server-side with ffmpeg; the page copes without it.
    ["GET", /^\/api\/public\/(previews|preview-videos|preview-audio|stories|story-backgrounds)\//, () => notFound],
  ];
}

/** A distinct generated cover per id: two-tone gradient with a soft disc. */
function cover(key: string): Reply {
  // FNV-1a, so ids that share a prefix still get far-apart hues.
  let hash = 0x811c9dc5;
  for (const ch of key) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  const hue = Math.round(((hash * 0.618_033_988_75) % 1) * 360);
  const hue2 = (hue + 40 + (hash % 80)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue} 55% 42%)"/><stop offset="1" stop-color="hsl(${hue2} 60% 22%)"/>
</linearGradient></defs>
<rect width="512" height="512" fill="url(#g)"/>
<circle cx="${180 + (hash % 160)}" cy="${170 + ((hash >> 8) % 170)}" r="${90 + (hash % 60)}" fill="hsl(${hue2} 70% 70% / 0.35)"/>
</svg>`;
  return { body: svg, contentType: "image/svg+xml" };
}

const wavCache = new Map<number, Buffer>();

/** Silence as 8 kHz 8-bit mono PCM, as long as the track, so the player bar
 *  shows the track's real length without any audio. */
function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.max(1, Math.round(seconds * rate));
  const cached = wavCache.get(samples);
  if (cached) return cached;
  const wav = Buffer.alloc(44 + samples, 0x80);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + samples, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate, 28); // byte rate
  wav.writeUInt16LE(1, 32); // block align
  wav.writeUInt16LE(8, 34); // bits per sample
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples, 40);
  wavCache.set(samples, wav);
  return wav;
}
