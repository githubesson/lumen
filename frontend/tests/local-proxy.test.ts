// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createLocalProxy } from "../electron/local-proxy";

async function makeDist(): Promise<string> {
  const distDir = await mkdtemp(join(tmpdir(), "lumen-proxy-test-"));
  await mkdir(join(distDir, "assets"));
  await writeFile(join(distDir, "index.html"), "<html>Lumen</html>");
  await writeFile(join(distDir, "assets", "app-hash.js"), "export default 1");
  return distDir;
}

// fetch() won't send a forged Host header, so these go through node:http.
function statusFor(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path, headers: { host }, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on("error", reject);
  });
}

function upgradeFor(port: number, host: string): Promise<number | "destroyed"> {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/api/activity/ws",
      agent: false,
      headers: { host, connection: "Upgrade", upgrade: "websocket" },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve("destroyed"));
    req.end();
  });
}

it("reuses a saved origin, caches assets and falls back safely on port collisions", async () => {
  const distDir = await makeDist();
  const options = { distDir, getBackendUrl: () => "" };
  const first = createLocalProxy(options);
  const second = createLocalProxy(options);
  try {
    const savedPort = await first.start(0);
    const asset = await fetch(`http://127.0.0.1:${savedPort}/assets/app-hash.js`);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const document = await fetch(`http://127.0.0.1:${savedPort}/library`);
    expect(document.headers.get("cache-control")).toBe("no-cache");
    const fallbackPort = await second.start(savedPort);
    expect(fallbackPort).not.toBe(savedPort);
    first.close();
    expect(await first.start(savedPort)).toBe(savedPort);
  } finally {
    first.close(); second.close();
    await rm(distDir, { recursive: true, force: true });
  }
});

it("falls back on any listen error for the preferred port and only fails when port 0 does too", async () => {
  const distDir = await makeDist();
  const listen = net.Server.prototype.listen;
  let blocked: (port: unknown) => boolean = (port) => port === 48637;
  // What Windows reports for a port inside a Hyper-V/WSL/Docker excluded range.
  vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: unknown[]) {
    if (!blocked(args[0])) return Reflect.apply(listen, this, args) as net.Server;
    const error = Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${String(args[0])}`), { code: "EACCES" });
    process.nextTick(() => this.emit("error", error));
    return this;
  });
  const proxy = createLocalProxy({ distDir, getBackendUrl: () => "" });
  try {
    const port = await proxy.start(48637);
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(48637);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    proxy.close();

    blocked = () => true;
    await expect(proxy.start(48637)).rejects.toMatchObject({ code: "EACCES" });
  } finally {
    vi.restoreAllMocks();
    proxy.close();
    await rm(distDir, { recursive: true, force: true });
  }
});

it("rejects requests and upgrades whose Host is not the proxy's own loopback origin", async () => {
  const distDir = await makeDist();
  const backend = http.createServer((_req, res) => res.end("ok"));
  backend.on("upgrade", (_req, socket: net.Socket) => {
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendPort = (backend.address() as net.AddressInfo).port;
  const proxy = createLocalProxy({ distDir, getBackendUrl: () => `http://127.0.0.1:${backendPort}` });
  try {
    const port = await proxy.start(0);
    const foreign = `attacker.example:${port}`;
    expect(await statusFor(port, "/", `127.0.0.1:${port}`)).toBe(200);
    expect(await statusFor(port, "/", `localhost:${port}`)).toBe(200);
    expect(await statusFor(port, "/api/ping", `127.0.0.1:${port}`)).toBe(200);
    expect(await statusFor(port, "/", foreign)).toBe(403);
    expect(await statusFor(port, "/api/ping", foreign)).toBe(403);
    expect(await statusFor(port, "/", "127.0.0.1:1")).toBe(403);
    expect(await upgradeFor(port, `127.0.0.1:${port}`)).toBe(101);
    expect(await upgradeFor(port, foreign)).toBe("destroyed");
  } finally {
    proxy.close();
    backend.closeAllConnections();
    backend.close();
    await rm(distDir, { recursive: true, force: true });
  }
});
