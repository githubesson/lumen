// @vitest-environment node
import * as http from "node:http";
import * as net from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import {
  createNowPlayingServer,
  DEFAULT_NOW_PLAYING_PORT,
  newNowPlayingToken,
  nowPlayingPort,
  nowPlayingToken,
  type NowPlayingServer,
  type NowPlayingSnapshot,
} from "../electron/now-playing";

const APP_ORIGIN = "http://127.0.0.1:48637";
const SIGNED_COVER = `${APP_ORIGIN}/api/public/covers/album/a1?exp=1&sig=s`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const TOKEN = "test-token-0123456789";

const servers: NowPlayingServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function serve(fetchCover = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()) {
  const server = createNowPlayingServer({ fetch: fetchCover, appOrigin: () => APP_ORIGIN });
  servers.push(server);
  server.token = TOKEN;
  await server.start(await freePort());
  return { server, fetchCover };
}

/** An API address with the token. */
const at = (server: NowPlayingServer, path: string) => `${server.url}${path}?token=${server.token}`;

const nowPlaying = async (server: NowPlayingServer) =>
  (await (await fetch(at(server, "/now-playing"))).json()) as NowPlayingSnapshot;

// fetch() won't send a forged Host header, so this goes through node:http.
function statusFor(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers: { host }, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on("error", reject);
  });
}

it("reports nothing, then the track, with progress counted forward while playing", async () => {
  const { server } = await serve();
  const empty = await fetch(at(server, "/now-playing"));
  expect(empty.headers.get("access-control-allow-origin")).toBe("*");
  expect(empty.headers.get("cache-control")).toBe("no-store");
  expect(await empty.json()).toEqual({ playing: false, track: null });

  server.update({
    trackId: "t1",
    title: " Musze To Mieć ",
    artist: "Kaz Bałagane",
    album: "Musze To Mieć",
    durationSec: 203,
    elapsedSec: 181,
    coverUrl: "https://resources.tidal.com/images/a/b/c/640x640.jpg",
    isPlaying: true,
  });
  const playing = await nowPlaying(server);
  expect(playing).toMatchObject({
    playing: true,
    track: { id: "t1", title: "Musze To Mieć", artist: "Kaz Bałagane", album: "Musze To Mieć", durationSec: 203 },
  });
  expect(playing.track!.positionSec).toBeGreaterThanOrEqual(181);
  expect(playing.track!.positionSec).toBeLessThan(182);
  expect(playing.track!.coverUrl).toMatch(new RegExp(`^${server.url}/cover\\?v=[0-9a-f]{12}&token=${TOKEN}$`));

  // Paused holds its place; a position past the end is held at the end.
  server.update({ title: "Song", elapsedSec: 42, isPlaying: false });
  expect((await nowPlaying(server)).track).toEqual({
    id: null, title: "Song", artist: null, album: null, durationSec: null, positionSec: 42, coverUrl: null,
  });
  server.update({ title: "Song", durationSec: 100, elapsedSec: 150, isPlaying: true });
  expect((await nowPlaying(server)).track!.positionSec).toBe(100);

  server.update(null);
  expect(await nowPlaying(server)).toEqual({ playing: false, track: null });
});

it("only answers loopback names, and only reads", async () => {
  const { server } = await serve();
  const port = new URL(server.url).port;
  expect(await statusFor(at(server, "/now-playing"), `127.0.0.1:${port}`)).toBe(200);
  expect(await statusFor(at(server, "/now-playing"), `localhost:${port}`)).toBe(200);
  // A rebinding page sends its own hostname.
  expect(await statusFor(at(server, "/now-playing"), `attacker.example:${port}`)).toBe(403);
  expect((await fetch(at(server, "/now-playing"), { method: "POST" })).status).toBe(405);
  expect((await fetch(at(server, "/elsewhere"))).status).toBe(404);
  const preflight = await fetch(`${server.url}/now-playing`, { method: "OPTIONS" });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");
  expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
});

it("answers only requests carrying the token, in the query or as a bearer", async () => {
  const { server } = await serve();
  server.update({ title: "Song", coverUrl: "https://cdn.example/c.png", isPlaying: true });
  for (const path of ["/now-playing", "/cover", "/events"]) {
    const missing = await fetch(`${server.url}${path}`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("access-control-allow-origin")).toBe("*");
    expect((await fetch(`${server.url}${path}?token=${TOKEN}x`)).status).toBe(401);
    expect((await fetch(`${server.url}${path}?token=${TOKEN.slice(1)}`)).status).toBe(401);
  }
  const bearer = await fetch(`${server.url}/now-playing`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(bearer.status).toBe(200);
  expect((await fetch(`${server.url}/now-playing`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  // With no token set, nothing gets in.
  server.token = "";
  expect((await fetch(`${server.url}/now-playing?token=`)).status).toBe(401);
});

it("serves the current cover, fetched once per cover", async () => {
  const fetchCover = vi.fn(async () => new Response(PNG, { headers: { "Content-Type": "image/png" } }));
  const { server } = await serve(fetchCover);
  expect((await fetch(at(server, "/cover"))).status).toBe(404);

  server.update({ title: "Song", coverUrl: SIGNED_COVER, isPlaying: true });
  // What an overlay's <img> loads: the coverUrl, token and all.
  const { coverUrl } = (await nowPlaying(server)).track!;
  for (let i = 0; i < 2; i++) {
    const cover = await fetch(coverUrl!);
    expect(cover.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await cover.arrayBuffer())).toEqual(PNG);
  }
  expect(fetchCover).toHaveBeenCalledTimes(1);
  expect(fetchCover.mock.calls[0]).toEqual([SIGNED_COVER, expect.objectContaining({ credentials: "omit" })]);
});

it("fetches covers only from https or the app's signed paths, and serves only raster images", async () => {
  const fetchCover = vi.fn(async () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }));
  const { server } = await serve(fetchCover);
  for (const coverUrl of ["http://192.168.1.1/admin", `${APP_ORIGIN}/api/tracks/t1/stream`, "file:///etc/passwd"]) {
    server.update({ title: "Song", coverUrl, isPlaying: true });
    expect((await fetch(at(server, "/cover"))).status).toBe(404);
  }
  expect(fetchCover).not.toHaveBeenCalled();

  server.update({ title: "Song", coverUrl: "https://cdn.example/cover.svg", isPlaying: true });
  expect((await fetch(at(server, "/cover"))).status).toBe(404);
  // A failed cover is tried again on the next request.
  await fetch(at(server, "/cover"));
  expect(fetchCover).toHaveBeenCalledTimes(2);
});

it("streams each change to /events", async () => {
  const { server } = await serve();
  server.update({ title: "First", isPlaying: false });
  const response = await fetch(at(server, "/events"));
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const next = async () => {
    const { value } = await reader.read();
    return JSON.parse(value!.replace(/^data: /, "").trim()) as NowPlayingSnapshot;
  };
  expect((await next()).track?.title).toBe("First");
  server.update({ title: "Second", isPlaying: true });
  expect(await next()).toMatchObject({ playing: true, track: { title: "Second" } });
  server.update(null);
  expect(await next()).toEqual({ playing: false, track: null });
  // A new token ends the stream opened with the old one.
  server.token = "next-token-0123456789";
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect((await fetch(`${server.url}/now-playing?token=${TOKEN}`)).status).toBe(401);
});

it("says which port is taken instead of moving to another", async () => {
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const { port } = holder.address() as net.AddressInfo;
  const server = createNowPlayingServer({ fetch: vi.fn(), appOrigin: () => "" });
  servers.push(server);
  try {
    await expect(server.start(port)).rejects.toThrow(`Port ${port} is in use by another app.`);
    expect(server.error).toBe(`Port ${port} is in use by another app.`);
    expect(server.url).toBe("");
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
  await server.start(port);
  expect(server.error).toBe("");
  expect(server.url).toBe(`http://127.0.0.1:${port}`);
  server.close();
  expect(server.url).toBe("");
});

it("reads the port and token from config.json, falling back when they're unusable", () => {
  expect(nowPlayingPort(9000)).toBe(9000);
  for (const raw of [undefined, 0, -1, 70000, 1.5, "9000"]) expect(nowPlayingPort(raw)).toBe(DEFAULT_NOW_PLAYING_PORT);
  const token = newNowPlayingToken();
  expect(token).toMatch(/^[\w-]{32}$/);
  expect(nowPlayingToken(token)).toBe(token);
  for (const raw of [undefined, "", "short", "has spaces in it, too long", 42]) expect(nowPlayingToken(raw)).toBe("");
});
