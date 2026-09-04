import { app, BrowserWindow, Menu, ipcMain, screen, session, dialog, shell } from "electron";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { OpenDialogOptions, Rectangle } from "electron";
import {
  DesktopUpdateManager,
  normalizeUpdateBranch,
  parseGitHubRepoUrl,
  type UpdateBranch,
} from "./updater";
import {
  loadConfig,
  saveConfigPatch,
  type Config,
  type SavePatch,
  type Tweaks,
} from "./config";
import {
  DEFAULT_FH6_BRIDGE_PORT,
  fh6BridgeUrl,
  fh6Status,
  installFH6Radio,
  normalizeGameDir,
  type FH6InstallRequest,
} from "./fh6-radio";
import {
  clearDiscordActivity,
  configureDiscordPresence,
  pushDiscordActivity,
  teardownDiscordPresence,
  type DiscordActivityPayload,
} from "./discord-presence";
import { createLocalProxy } from "./local-proxy";

export type { Density, Layout, Theme, Tweaks } from "./config";

interface SetupDoneOpts {
  clearSession?: boolean;
}

interface ExportTrackFileItem {
  url: string;
  filename: string;
}

const DIST_DIR = path.join(__dirname, "..", "..", "dist");
const SETUP_FILE = path.join(__dirname, "..", "setup.html");
const SETUP_PRELOAD = path.join(__dirname, "preload.js");
const MAIN_PRELOAD = path.join(__dirname, "mainPreload.js");
const FALLBACK_UPDATE_REPO_URL = "https://github.com/githubesson/lumen";
const NORMAL_MIN_SIZE = { width: 640, height: 480 };
const MINI_PLAYER_SIZE = { width: 780, height: 184 };
const BUILD_ENV = readBakedBuildEnv();
const DEFAULT_DISCORD_CLIENT_ID = (BUILD_ENV.discordClientId ?? "").trim();
const DEFAULT_UPDATE_REPO_URL =
  parseGitHubRepoUrl(BUILD_ENV.updateRepoUrl)?.url ?? FALLBACK_UPDATE_REPO_URL;
const DEFAULT_UPDATE_BRANCH: UpdateBranch = /-dev(?:\.|$)/.test(app.getVersion())
  ? "dev"
  : "main";
const updateManager = new DesktopUpdateManager(
  DEFAULT_UPDATE_REPO_URL,
  DEFAULT_UPDATE_BRANCH,
  BUILD_ENV.macUpdateSigned === true,
);

let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let backendUrl = "";
let isMiniPlayer = false;
let normalBounds: Rectangle | null = null;
let alwaysOnTop = false;
const localProxy = createLocalProxy({
  distDir: DIST_DIR,
  getBackendUrl: () => backendUrl,
});

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// The renderer only ever needs the local proxy origin (and, for the setup
// window, a file:// page). Without these guards a compromised or injected
// renderer could navigate the main window to any remote origin, and
// `window.open` would create unrestricted child BrowserWindows. contextIsolation
// + sandbox + nodeIntegration:false make that not-immediately-RCE, but this is
// the standard Electron hardening baseline and the missing link that turns a
// renderer compromise into a real chain.
function isInternalURL(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol === "file:") return true;
    return (
      u.protocol === "http:" &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
      u.port === String(localProxy.port)
    );
  } catch {
    return false;
  }
}

function hardenNavigation(win: BrowserWindow): void {
  const block = (event: { preventDefault: () => void }, url: string) => {
    if (isInternalURL(url)) return;
    event.preventDefault();
    console.warn("[electron] blocked navigation to", url);
  };
  win.webContents.on("will-navigate", (event, url) => block(event, url));
  win.webContents.on("will-redirect", (event, url) => block(event, url));
  // Never open a child BrowserWindow. External links go through the
  // `external:open` IPC, which validates the protocol and hands off to the
  // system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

async function openMain(): Promise<void> {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: NORMAL_MIN_SIZE.width,
    minHeight: NORMAL_MIN_SIZE.height,
    backgroundColor: "#00000000",
    frame: false,
    transparent: true,
    title: "Lumen — Music Library",
    autoHideMenuBar: true,
    alwaysOnTop,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: MAIN_PRELOAD,
    },
  });
  hardenNavigation(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = null;
    isMiniPlayer = false;
    normalBounds = null;
  });
  await mainWindow.loadURL(`http://127.0.0.1:${localProxy.port}/`);
}

function openSetup(): void {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 520,
    height: 540,
    parent: mainWindow ?? undefined,
    modal: !!mainWindow,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: "Server configuration",
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      preload: SETUP_PRELOAD,
    },
  });
  hardenNavigation(setupWindow);
  setupWindow.setMenuBarVisibility(false);
  setupWindow.on("closed", () => {
    setupWindow = null;
  });
  void setupWindow.loadFile(SETUP_FILE);
}

ipcMain.handle("config:get", async () => {
  const cfg = await loadConfig();
  return {
    backendUrl: cfg.backendUrl ?? "",
    // `discordEnabled` defaults to true so existing installs keep the
    // integration on without a migration step.
    discordEnabled: cfg.discordEnabled ?? true,
    alwaysOnTop: cfg.alwaysOnTop ?? false,
    fh6RadioEnabled: cfg.fh6RadioEnabled === true,
    fh6GameDir: cfg.fh6GameDir ?? "",
    fh6BridgePort: cfg.fh6BridgePort ?? DEFAULT_FH6_BRIDGE_PORT,
  };
});

ipcMain.handle("tweaks:get", async () => {
  const cfg = await loadConfig();
  return { tweaks: cfg.tweaks ?? {}, audioSinkId: cfg.audioSinkId ?? "" };
});

ipcMain.handle("tweaks:save", async (_e, payload: { tweaks?: Partial<Tweaks>; audioSinkId?: string }) => {
  const patch: Config = {};
  if (payload.tweaks) patch.tweaks = payload.tweaks;
  if (typeof payload.audioSinkId === "string") patch.audioSinkId = payload.audioSinkId;
  await saveConfigPatch(patch);
  return { ok: true };
});

ipcMain.handle("updates:get", () => updateManager.getStatus());

ipcMain.handle(
  "updates:save",
  async (_e, payload: { branch?: unknown; repoUrl?: unknown } | undefined) => {
    const branch = normalizeUpdateBranch(payload?.branch);
    if (!branch) {
      return { ok: false, error: "Update branch must be main or dev." };
    }
    const repo = parseGitHubRepoUrl(payload?.repoUrl);
    if (!repo) {
      return {
        ok: false,
        error: "Repository must be an https://github.com/owner/repo URL.",
      };
    }
    await saveConfigPatch({ updateBranch: branch, updateRepoUrl: repo.url });
    const status = updateManager.configure({ branch, repoUrl: repo.url });
    updateManager.startAutomaticChecks();
    return { ok: true, status };
  },
);

ipcMain.handle("updates:check", async () => updateManager.check());
ipcMain.handle("updates:install", () => updateManager.install());

// Renderer origins use an ephemeral proxy port, so logout intent must live
// in userData rather than port-scoped localStorage across desktop restarts.
const authIntentPath = () => path.join(app.getPath("userData"), "signed-out");
ipcMain.handle("auth:intent:get", async () => {
  try { return await fsp.readFile(authIntentPath(), "utf8") === "1"; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
});
ipcMain.handle("auth:intent:set", async (_event, signedOut: boolean) => {
  if (typeof signedOut !== "boolean") throw new Error("Invalid sign-out intent");
  if (signedOut) {
    await fsp.mkdir(app.getPath("userData"), { recursive: true });
    await fsp.writeFile(authIntentPath(), "1", { flush: true });
  } else {
    await fsp.rm(authIntentPath(), { force: true });
  }
});

ipcMain.handle("config:save", async (_e, patch: SavePatch) => {
  const raw = typeof patch?.backendUrl === "string" ? patch.backendUrl.trim() : "";
  if (!raw) return { ok: false, error: "Server URL is required" };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return { ok: false, error: `Invalid URL: ${(e as Error).message}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "URL must start with http:// or https://" };
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    return { ok: false, error: "Use the server origin only (for example https://music.example.com). Paths, query strings, fragments, and embedded credentials are not supported." };
  }
  const normalized = parsed.origin;
  const prev = backendUrl;
  const writePatch: SavePatch = { backendUrl: normalized };
  if (typeof patch?.discordEnabled === "boolean") {
    writePatch.discordEnabled = patch.discordEnabled;
    configureDiscordPresence({ enabled: patch.discordEnabled });
  }
  if (typeof patch?.alwaysOnTop === "boolean") {
    writePatch.alwaysOnTop = patch.alwaysOnTop;
    alwaysOnTop = patch.alwaysOnTop;
    mainWindow?.setAlwaysOnTop(alwaysOnTop);
  }
  if (typeof patch?.fh6RadioEnabled === "boolean") {
    writePatch.fh6RadioEnabled = patch.fh6RadioEnabled;
  }
  if (typeof patch?.fh6GameDir === "string") {
    writePatch.fh6GameDir = normalizeGameDir(patch.fh6GameDir);
  }
  if (typeof patch?.fh6BridgePort === "number") {
    writePatch.fh6BridgePort = Math.max(1, Math.min(65535, Math.floor(patch.fh6BridgePort)));
  }
  await saveConfigPatch(writePatch);
  backendUrl = normalized;
  configureDiscordPresence({ backendUrl: normalized });
  return { ok: true, changed: prev !== "" && prev !== normalized };
});

ipcMain.handle("setup:done", async (_e, opts: SetupDoneOpts | undefined) => {
  const clear = !!opts?.clearSession;
  const hadMain = !!mainWindow;
  if (setupWindow) setupWindow.close();
  if (clear) {
    try {
      await session.defaultSession.clearStorageData({ storages: ["cookies"] });
    } catch {
      // Non-fatal: stale cookies will simply be rejected by the new backend.
    }
  }
  if (!hadMain) await openMain();
  else mainWindow?.webContents.reload();
  return { ok: true };
});

ipcMain.handle("setup:cancel", async () => {
  if (setupWindow) setupWindow.close();
  if (!mainWindow && !backendUrl) app.quit();
  return { ok: true };
});

ipcMain.handle("settings:open", () => {
  openSetup();
  return { ok: true };
});

ipcMain.handle("external:open", async (_e, rawUrl: unknown) => {
  if (typeof rawUrl !== "string") {
    return { ok: false, error: "URL is required." };
  }
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, error: "Only HTTP and HTTPS links can be opened." };
    }
    await shell.openExternal(url.href);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not open link.",
    };
  }
});

ipcMain.handle("window:mini-player:set", (_e, enabled: boolean) => {
  if (!mainWindow) return { ok: false, miniPlayer: isMiniPlayer };
  setMiniPlayerMode(enabled);
  return { ok: true, miniPlayer: isMiniPlayer };
});

ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
  return { ok: true };
});

ipcMain.handle("window:maximize-toggle", () => {
  if (!mainWindow || isMiniPlayer) return { ok: false, maximized: false };
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { ok: true, maximized: mainWindow.isMaximized() };
});

ipcMain.handle("window:close", () => {
  mainWindow?.close();
  return { ok: true };
});

ipcMain.handle("tracks:export-files", async (_e, rawItems: ExportTrackFileItem[]) => {
  try {
    const items = Array.isArray(rawItems)
      ? rawItems.filter(
          (item) =>
            item &&
            typeof item.url === "string" &&
            typeof item.filename === "string" &&
            item.url.trim() &&
            item.filename.trim(),
        )
      : [];
    if (items.length === 0) {
      return { ok: false, error: "No files selected for export." };
    }

    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: "Choose export folder",
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          title: "Choose export folder",
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }

    const folder = result.filePaths[0];
    const cookieHeader = await appCookieHeader();
    let saved = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const item of items) {
      try {
        const urlString = exportDownloadUrl(item.url);
        const dest = await uniqueExportPath(folder, item.filename);
        await downloadToFile(urlString, dest, cookieHeader);
        saved += 1;
      } catch (e) {
        failed += 1;
        if (errors.length < 5) {
          errors.push(`${item.filename}: ${(e as Error).message}`);
        }
      }
    }

    return {
      ok: failed === 0,
      folder,
      saved,
      failed,
      errors,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

ipcMain.handle("fh6:status", async () => fh6Status());

ipcMain.handle("fh6:choose-game-dir", async () => {
  const options: OpenDialogOptions = {
    title: "Choose Forza Horizon 6 install folder",
    properties: ["openDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  const gameDir = normalizeGameDir(result.filePaths[0]);
  await saveConfigPatch({ fh6GameDir: gameDir });
  return { ok: true, gameDir, status: await fh6Status() };
});

ipcMain.handle("fh6:choose-media-source", async () => {
  const options: OpenDialogOptions = {
    title: "Choose radio media ZIP or folder",
    properties: ["openFile", "openDirectory"],
    filters: [
      { name: "Radio media", extensions: ["zip"] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  return { ok: true, path: normalizeGameDir(result.filePaths[0]) };
});

ipcMain.handle("fh6:install", async (_e, req: FH6InstallRequest) => {
  try {
    return await installFH6Radio(req ?? {});
  } catch (e) {
    return { ok: false, error: (e as Error).message, status: await fh6Status() };
  }
});

ipcMain.handle("fh6:sync-session", async () => {
  try {
    const cfg = await loadConfig();
    if (cfg.fh6RadioEnabled !== true) {
      return { ok: false, error: "Lumen Radio is disabled in settings" };
    }
    if (!backendUrl) return { ok: false, error: "Backend URL is not configured" };
    if (!localProxy.port) return { ok: false, error: "Local app proxy is not ready" };

    const cookieHeader = await appCookieHeader();
    if (!cookieHeader) return { ok: false, error: "Log in to Lumen first" };

    const bridgeUrl = fh6BridgeUrl(cfg.fh6BridgePort ?? DEFAULT_FH6_BRIDGE_PORT);
    return await postJson(`${bridgeUrl}/api/lumen/session`, {
      server_url: backendUrl,
      session_cookie: cookieHeader,
      username: "",
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

async function appCookieHeader(): Promise<string> {
  const cookies = await session.defaultSession.cookies.get({
    url: `http://127.0.0.1:${localProxy.port}`,
  });
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// Only relative /api/ paths are accepted. The absolute-URL passthrough that
// used to live here handed the renderer a way to make the main process attach
// the app's session cookie to a request for any host it liked — dead code for
// the real UI (lib/download.ts only ever passes /api/tracks/<id>/stream), but
// a live capability for anything else running in the renderer.
function exportDownloadUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Missing download URL");
  if (!trimmed.startsWith("/api/")) {
    throw new Error("Export URL must be an API path");
  }
  if (!localProxy.port) throw new Error("Local app proxy is not ready");
  return `http://127.0.0.1:${localProxy.port}${trimmed}`;
}

// The session cookie is scoped to the local proxy origin and must not survive a
// redirect off it. downloadToFile re-derives the header per hop from this.
function isAppOrigin(target: URL): boolean {
  return (
    target.protocol === "http:" &&
    (target.hostname === "127.0.0.1" || target.hostname === "localhost") &&
    target.port === String(localProxy.port)
  );
}

function sanitizeExportFilename(name: string): string {
  const sanitized = path
    .basename(name)
    // Control characters are exactly what we want to strip from a filename.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return sanitized || "track";
}

async function uniqueExportPath(folder: string, filename: string): Promise<string> {
  const safe = sanitizeExportFilename(filename);
  const parsed = path.parse(safe);
  const stem = parsed.name || "track";
  const ext = parsed.ext;
  for (let i = 0; i < 10000; i += 1) {
    const candidate = path.join(
      folder,
      i === 0 ? `${stem}${ext}` : `${stem} (${i})${ext}`,
    );
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("Could not choose a unique filename");
}

function downloadToFile(urlString: string, dest: string, cookieHeader: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl: string, redirects: number) => {
      const target = new URL(currentUrl);
      const lib = target.protocol === "https:" ? https : http;
      // Re-evaluated per hop rather than captured once in the closure: a
      // redirect to any other host used to receive the session cookie too.
      const sendCookie = cookieHeader && isAppOrigin(target);
      const req = lib.get(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: target.pathname + target.search,
          headers: {
            Accept: "application/octet-stream,*/*",
            ...(sendCookie ? { Cookie: cookieHeader } : {}),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (status >= 300 && status < 400 && location) {
            res.resume();
            if (redirects <= 0) {
              reject(new Error("Too many redirects"));
              return;
            }
            attempt(new URL(location, target).toString(), redirects - 1);
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            reject(new Error(`HTTP ${status || "error"}`));
            return;
          }

          const out = fs.createWriteStream(dest, { flags: "wx" });
          pipeline(res, out)
            .then(() => resolve())
            .catch(async (e) => {
              try {
                await fsp.rm(dest, { force: true });
              } catch {
                // Best-effort cleanup; the original stream error is clearer.
              }
              reject(e);
            });
        },
      );
      req.on("error", reject);
      req.setTimeout(120000, () => {
        req.destroy(new Error("Download timed out"));
      });
    };
    attempt(urlString, 5);
  });
}

function postJson(urlString: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const target = new URL(urlString);
    const data = JSON.stringify(body);
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 4000,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300) {
            resolve({ ok: true });
            return;
          }
          try {
            const parsed = JSON.parse(raw) as { error?: string };
            resolve({ ok: false, error: parsed.error ?? raw });
          } catch {
            resolve({ ok: false, error: raw || `HTTP ${res.statusCode}` });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("FH6 bridge did not respond"));
    });
    req.on("error", (e) => {
      resolve({ ok: false, error: e.message });
    });
    req.end(data);
  });
}

function setMiniPlayerMode(enabled: boolean): void {
  if (!mainWindow || enabled === isMiniPlayer) return;

  if (enabled) {
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      normalBounds = mainWindow.getBounds();
    }
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    mainWindow.setMinimumSize(MINI_PLAYER_SIZE.width, MINI_PLAYER_SIZE.height);
    mainWindow.setMaximumSize(MINI_PLAYER_SIZE.width, MINI_PLAYER_SIZE.height);
    mainWindow.setResizable(false);
    mainWindow.setMaximizable(false);
    mainWindow.setBounds(
      boundsAroundCenter(mainWindow.getBounds(), MINI_PLAYER_SIZE),
      true,
    );
  } else {
    mainWindow.setResizable(true);
    mainWindow.setMaximizable(true);
    mainWindow.setMaximumSize(10000, 10000);
    mainWindow.setMinimumSize(NORMAL_MIN_SIZE.width, NORMAL_MIN_SIZE.height);
    if (normalBounds) {
      mainWindow.setBounds(normalBounds, true);
      normalBounds = null;
    } else {
      mainWindow.setSize(1280, 820, true);
    }
  }

  isMiniPlayer = enabled;
}

function boundsAroundCenter(
  bounds: Rectangle,
  size: { width: number; height: number },
): Rectangle {
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const x = Math.round(
    Math.max(area.x, Math.min(area.x + area.width - size.width, centerX - size.width / 2)),
  );
  const y = Math.round(
    Math.max(area.y, Math.min(area.y + area.height - size.height, centerY - size.height / 2)),
  );
  return { x, y, width: size.width, height: size.height };
}

// ────────────────────────────────────────────────────────────────────────
// Discord Rich Presence
//
// Loaded lazily so a missing `discord-rpc` dependency doesn't prevent the
// app from booting. The package is optional — if `discordClientId` is
// blank or the local Discord client isn't running, presence silently stays
// off. Activity type 2 ("Listening") is what makes Discord render
// "Listening to Lumen" above the card (instead of "Playing").
// ────────────────────────────────────────────────────────────────────────

interface BuildEnvironment {
  discordClientId?: string;
  updateRepoUrl?: string;
  macUpdateSigned?: boolean;
}

function readBakedBuildEnv(): BuildEnvironment {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "buildenv.json"), "utf8");
    return JSON.parse(raw) as BuildEnvironment;
  } catch {
    return {};
  }
}

ipcMain.handle("discord:activity", async (_e, payload: DiscordActivityPayload) => {
  if (!payload || typeof payload.title !== "string") {
    return { ok: false, error: "invalid payload" };
  }
  return pushDiscordActivity(payload);
});

ipcMain.handle("discord:clear", async () => {
  await clearDiscordActivity();
  return { ok: true };
});

ipcMain.handle(
  "titlebar:theme",
  (_e, opts: { color?: string; symbolColor?: string } | undefined) => {
    // The renderer's accent colours are applied by CSS; the main process only
    // needs to re-assert a transparent backdrop so the frame repaints.
    if (!opts) return { ok: false };
    if (!mainWindow) return { ok: true };
    if (process.platform !== "win32" && process.platform !== "linux") {
      return { ok: true };
    }
    try {
      mainWindow.setBackgroundColor("#00000000");
    } catch {
      // Platform may not support overlay updates.
    }
    return { ok: true };
  },
);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (setupWindow) {
      setupWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // Grant `media` so `navigator.mediaDevices.enumerateDevices()` returns
    // labelled `audiooutput` entries. Chromium hides labels until microphone
    // permission is granted; without this the device picker shows blanks.
    // Chromium's `media` permission covers the *microphone*, so it is granted
    // only to our own loopback origin — not to whatever content happens to be
    // loaded in the default session.
    const mediaAllowedFor = (origin: string | undefined): boolean => {
      if (!origin) return false;
      try {
        const u = new URL(origin);
        return (
          u.protocol === "http:" &&
          (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
          u.port === String(localProxy.port)
        );
      } catch {
        return false;
      }
    };
    session.defaultSession.setPermissionRequestHandler(
      (wc, permission, callback) => {
        callback(
          permission === "media" && mediaAllowedFor(wc?.getURL?.()),
        );
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (_wc, permission, requestingOrigin) =>
        permission === "media" && mediaAllowedFor(requestingOrigin),
    );
    const cfg = await loadConfig();
    backendUrl = cfg.backendUrl ?? "";
    try {
      const configured = new URL(backendUrl);
      if (!["http:", "https:"].includes(configured.protocol) || configured.pathname !== "/" || configured.search || configured.hash || configured.username || configured.password) backendUrl = "";
    } catch { backendUrl = ""; }
    configureDiscordPresence({
      clientId: (cfg.discordClientId ?? "").trim() || DEFAULT_DISCORD_CLIENT_ID,
      enabled: cfg.discordEnabled ?? true,
      backendUrl,
    });
    alwaysOnTop = cfg.alwaysOnTop ?? false;
    const updateBranch =
      normalizeUpdateBranch(cfg.updateBranch) ?? DEFAULT_UPDATE_BRANCH;
    const updateRepoUrl =
      parseGitHubRepoUrl(cfg.updateRepoUrl)?.url ?? DEFAULT_UPDATE_REPO_URL;
    updateManager.configure({ branch: updateBranch, repoUrl: updateRepoUrl });
    updateManager.startAutomaticChecks();
    await localProxy.start();
    if (!backendUrl) openSetup();
    else await openMain();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!backendUrl) openSetup();
      else void openMain();
    }
  });

  app.on("before-quit", () => {
    localProxy.close();
    void teardownDiscordPresence();
  });
}
