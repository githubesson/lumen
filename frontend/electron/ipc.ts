import { app, ipcMain, net, session, dialog, shell } from "electron";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { OpenDialogOptions } from "electron";
import {
  normalizeUpdateBranch,
  parseGitHubRepoUrl,
  type DesktopUpdateManager,
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
  type DiscordActivityPayload,
} from "./discord-presence";
import type { LocalProxy } from "./local-proxy";
import type { WindowManager } from "./windows";
import { downloadToFile, exportDownloadUrl, uniqueExportPath } from "./track-export";
import { postJson } from "./fh6-bridge";

import type { DesktopConfig, ExportTrackFileItem } from "../src/contracts/desktop";

async function readDesktopConfig(): Promise<DesktopConfig> {
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
}

/** Accept a server origin only, e.g. https://music.example.com. */
function normalizeBackendUrl(
  raw: unknown,
): { ok: true; url: string } | { ok: false; error: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, error: "Server URL is required" };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch (e) {
    return { ok: false, error: `Invalid URL: ${(e as Error).message}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "URL must start with http:// or https://" };
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    return { ok: false, error: "Use the server origin only (for example https://music.example.com). Paths, query strings, fragments, and embedded credentials are not supported." };
  }
  return { ok: true, url: parsed.origin };
}

export function registerIpcHandlers(deps: {
  windows: WindowManager;
  localProxy: LocalProxy;
  updateManager: DesktopUpdateManager;
  getBackendUrl: () => string;
  setBackendUrl: (url: string) => void;
}): void {
  const { windows, localProxy, updateManager } = deps;

  ipcMain.handle("config:get", () => readDesktopConfig());

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

  // Validate a patch, persist it and apply its live side effects. Every field
  // is optional, so Settings can flip one toggle at a time.
  async function applyConfigPatch(
    patch: SavePatch | undefined,
  ): Promise<{ ok: false; error: string } | { ok: true; changed: boolean }> {
    const writePatch: SavePatch = {};
    let normalized: string | null = null;
    if (patch?.backendUrl !== undefined) {
      const result = normalizeBackendUrl(patch.backendUrl);
      if (!result.ok) return result;
      normalized = result.url;
      writePatch.backendUrl = normalized;
    }
    if (typeof patch?.discordEnabled === "boolean") {
      writePatch.discordEnabled = patch.discordEnabled;
    }
    if (typeof patch?.alwaysOnTop === "boolean") {
      writePatch.alwaysOnTop = patch.alwaysOnTop;
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
    if (writePatch.discordEnabled !== undefined) {
      configureDiscordPresence({ enabled: writePatch.discordEnabled });
    }
    if (writePatch.alwaysOnTop !== undefined) {
      windows.alwaysOnTop = writePatch.alwaysOnTop;
      windows.mainWindow?.setAlwaysOnTop(windows.alwaysOnTop);
    }
    const prev = deps.getBackendUrl();
    if (normalized === null) return { ok: true, changed: false };
    deps.setBackendUrl(normalized);
    configureDiscordPresence({ backendUrl: normalized });
    return { ok: true, changed: prev !== normalized };
  }

  ipcMain.handle("config:update", async (_e, patch: SavePatch) => {
    const result = await applyConfigPatch(patch);
    if (!result.ok) return result;
    if (result.changed) {
      // A different server: its session cookies mean nothing there. Reply
      // first, then restart the app on the new server's sign-in page.
      try {
        await session.defaultSession.clearStorageData({ storages: ["cookies"] });
      } catch {
        // Non-fatal: stale cookies will simply be rejected by the new backend.
      }
      setTimeout(() => windows.mainWindow?.webContents.reload(), 0);
    }
    return { ...result, config: await readDesktopConfig() };
  });

  // First-run and change-server check: is there a Lumen server at this
  // address? Forgiving about what's typed (no scheme, a pasted page URL), and
  // answers with the origin to save, after any redirect (say, to https).
  ipcMain.handle("config:test-server", async (_e, raw: unknown) => {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return { ok: false, error: "Enter your server's address." };
    let target: URL;
    try {
      target = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      return { ok: false, error: "That doesn't look like a web address." };
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return { ok: false, error: "The address must start with http:// or https://." };
    }
    if (target.username || target.password) {
      return { ok: false, error: "Leave the username and password out of the address." };
    }
    let response: Response;
    try {
      response = await net.fetch(`${target.origin}/api/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
    } catch (error) {
      const timedOut = (error as Error).name === "TimeoutError";
      return {
        ok: false,
        error: timedOut
          ? `${target.host} didn't answer in time.`
          : `Couldn't reach ${target.host}. Check the address and that the server is running.`,
      };
    }
    const body = response.ok ? await response.json().catch(() => null) : null;
    if ((body as { ok?: unknown } | null)?.ok !== true) {
      return { ok: false, error: `${target.host} answered, but it isn't a Lumen server.` };
    }
    return { ok: true, url: new URL(response.url || target.href).origin };
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
    if (!windows.mainWindow) return { ok: false, miniPlayer: windows.isMiniPlayer };
    windows.setMiniPlayerMode(enabled);
    return { ok: true, miniPlayer: windows.isMiniPlayer };
  });

  ipcMain.handle("window:minimize", () => {
    windows.mainWindow?.minimize();
    return { ok: true };
  });

  ipcMain.handle("window:maximize-toggle", () => {
    const mainWindow = windows.mainWindow;
    if (!mainWindow || windows.isMiniPlayer) return { ok: false, maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true, maximized: mainWindow.isMaximized() };
  });

  ipcMain.handle("window:close", () => {
    windows.mainWindow?.close();
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

      const mainWindow = windows.mainWindow;
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
          const urlString = exportDownloadUrl(localProxy, item.url);
          const dest = await uniqueExportPath(folder, item.filename);
          await downloadToFile(localProxy, urlString, dest, cookieHeader);
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
    const mainWindow = windows.mainWindow;
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
    const mainWindow = windows.mainWindow;
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
      if (!deps.getBackendUrl()) return { ok: false, error: "Backend URL is not configured" };
      if (!localProxy.port) return { ok: false, error: "Local app proxy is not ready" };

      const cookieHeader = await appCookieHeader();
      if (!cookieHeader) return { ok: false, error: "Log in to Lumen first" };

      const bridgeUrl = fh6BridgeUrl(cfg.fh6BridgePort ?? DEFAULT_FH6_BRIDGE_PORT);
      return await postJson(`${bridgeUrl}/api/lumen/session`, {
        server_url: deps.getBackendUrl(),
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

  // ──────────────────────────────────────────────────────────────────────
  // Discord Rich Presence
  //
  // Loaded lazily so a missing `discord-rpc` dependency doesn't prevent the
  // app from booting. The package is optional — if `discordClientId` is
  // blank or the local Discord client isn't running, presence silently stays
  // off. Activity type 2 ("Listening") is what makes Discord render
  // "Listening to Lumen" above the card (instead of "Playing").
  // ──────────────────────────────────────────────────────────────────────

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
      if (!windows.mainWindow) return { ok: true };
      if (process.platform !== "win32" && process.platform !== "linux") {
        return { ok: true };
      }
      try {
        windows.mainWindow.setBackgroundColor("#00000000");
      } catch {
        // Platform may not support overlay updates.
      }
      return { ok: true };
    },
  );
}
