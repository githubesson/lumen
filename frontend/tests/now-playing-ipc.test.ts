// @vitest-environment node
import * as net from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Config } from "../electron/config";
import { createNowPlayingServer, type NowPlayingServer } from "../electron/now-playing";
import type { DesktopConfig, DesktopConfigUpdateResult } from "../src/contracts/desktop";

// The real IPC handlers over an in-memory config.json whose write queue
// behaves like saveConfigPatch's, and can be held or made to fail.
const { handlers, store } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  store: {
    disk: {} as Record<string, unknown>,
    writes: Promise.resolve() as Promise<unknown>,
    hold: null as Promise<void> | null,
    fail: false,
  },
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/nonexistent" },
  BrowserWindow: {},
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) },
  net: { fetch: () => Promise.reject(new Error("offline")) },
  session: { defaultSession: {} },
  dialog: {},
  shell: {},
}));

vi.mock("../electron/config", () => ({
  loadConfig: async () => ({ ...store.disk }),
  saveConfigPatch: (patch: Config | ((current: Config) => Config)) => {
    const write = store.writes.then(async () => {
      if (store.hold) await store.hold;
      if (store.fail) throw new Error("EACCES: config.json");
      store.disk = { ...store.disk, ...(typeof patch === "function" ? patch(store.disk as Config) : patch) };
      return { ...store.disk };
    });
    store.writes = write.catch(() => undefined);
    return write;
  },
}));

const { registerIpcHandlers } = await import("../electron/ipc");

let nowPlaying: NowPlayingServer;
let port: number;

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

beforeEach(async () => {
  Object.assign(store, { disk: {}, writes: Promise.resolve(), hold: null, fail: false });
  port = await freePort();
  nowPlaying = createNowPlayingServer({ fetch: vi.fn(), appOrigin: () => "" });
  // What main.ts does at launch when config.json has no token.
  nowPlaying.token = "launch-token-0123456789";
  registerIpcHandlers({
    windows: { mainWindow: null, alwaysOnTop: false } as never,
    localProxy: { port: 0 } as never,
    updateManager: {} as never,
    getBackendUrl: () => "",
    setBackendUrl: () => {},
    nowPlaying,
    nowPlayingPort: () => port,
  });
});

afterEach(() => nowPlaying.close());

const setEnabled = (enabled: boolean) =>
  handlers.get("config:update")!({}, { nowPlayingApiEnabled: enabled }) as Promise<DesktopConfigUpdateResult>;
const newToken = () => handlers.get("now-playing:new-token")!({}) as Promise<DesktopConfig>;
const status = async (token: string) => (await fetch(`${nowPlaying.url}/now-playing?token=${token}`)).status;

it("turns on with the launch token saved, and off again", async () => {
  const on = await setEnabled(true);
  expect(on).toMatchObject({
    ok: true,
    config: { nowPlayingApiEnabled: true, nowPlayingApiUrl: `http://127.0.0.1:${port}`, nowPlayingApiToken: "launch-token-0123456789" },
  });
  expect(store.disk).toMatchObject({ nowPlayingApiEnabled: true, nowPlayingApiToken: "launch-token-0123456789" });
  expect(await status("launch-token-0123456789")).toBe(200);

  const off = await setEnabled(false);
  expect(off).toMatchObject({ ok: true, config: { nowPlayingApiEnabled: false, nowPlayingApiUrl: "" } });
  expect(nowPlaying.url).toBe("");
});

it("keeps a token config.json already has", async () => {
  store.disk = { nowPlayingApiToken: "saved-token-0123456789" };
  await setEnabled(true);
  expect(store.disk.nowPlayingApiToken).toBe("saved-token-0123456789");
  expect(await status("saved-token-0123456789")).toBe(200);
  expect(await status("launch-token-0123456789")).toBe(401);
});

it("stays off when its port is taken or the save fails", async () => {
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
  expect(await setEnabled(true)).toEqual({ ok: false, error: `Port ${port} is in use by another app.` });
  expect(store.disk.nowPlayingApiEnabled).toBeUndefined();
  await new Promise((resolve) => holder.close(resolve));

  store.fail = true;
  await expect(setEnabled(true)).rejects.toThrow("EACCES");
  expect(nowPlaying.url).toBe("");
});

it("follows the newest save when an off is still queued as it's turned on", async () => {
  await setEnabled(true);
  let release!: () => void;
  store.hold = new Promise((resolve) => (release = resolve));
  const off = setEnabled(false);
  const on = setEnabled(true);
  store.hold = null;
  release();
  await off;
  expect(await on).toMatchObject({ ok: true, config: { nowPlayingApiEnabled: true, nowPlayingApiUrl: `http://127.0.0.1:${port}` } });
  expect(nowPlaying.url).toBe(`http://127.0.0.1:${port}`);
  expect(store.disk.nowPlayingApiEnabled).toBe(true);
});

it("swaps in a new token only once it's saved", async () => {
  await setEnabled(true);
  const renewed = await newToken();
  const token = renewed.nowPlayingApiToken;
  expect(token).not.toBe("launch-token-0123456789");
  expect(store.disk.nowPlayingApiToken).toBe(token);
  expect(await status(token)).toBe(200);
  expect(await status("launch-token-0123456789")).toBe(401);

  // Unsaved, the old token keeps working: it's still the one in config.json.
  store.fail = true;
  await expect(newToken()).rejects.toThrow("EACCES");
  expect(nowPlaying.token).toBe(token);
  expect(await status(token)).toBe(200);
});
