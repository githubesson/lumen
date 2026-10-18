import { app, ipcMain, net, session, dialog, shell } from "electron";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
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
  clearDiscordActivity,
  configureDiscordPresence,
  pushDiscordActivity,
  type DiscordActivityPayload,
} from "./discord-presence";
import { normalizeDiscordCard } from "./discord-card";
import type { LocalProxy } from "./local-proxy";
import { newNowPlayingToken, nowPlayingToken, type NowPlayingServer } from "./now-playing";
import type { WindowManager } from "./windows";
import { downloadToFile, exportDownloadUrl, uniqueExportPath } from "./track-export";

import type { DesktopConfig, ExportTrackFileItem } from "../src/contracts/desktop";

function desktopConfigOf(cfg: Config, nowPlaying: NowPlayingServer): DesktopConfig {
  return {
    backendUrl: cfg.backendUrl ?? "",
    // `discordEnabled` defaults to true so existing installs keep the
    // integration on without a migration step.
    discordEnabled: cfg.discordEnabled ?? true,
    alwaysOnTop: cfg.alwaysOnTop ?? false,
    discordCard: normalizeDiscordCard(cfg.discordCard),
    nowPlayingApiEnabled: cfg.nowPlayingApiEnabled === true,
    nowPlayingApiUrl: nowPlaying.url,
    nowPlayingApiToken: nowPlaying.token,
    nowPlayingApiError: nowPlaying.error,
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
  nowPlaying: NowPlayingServer;
  /** The now-playing API's port, read from config.json at launch. */
  nowPlayingPort: () => number;
}): void {
  const { windows, localProxy, updateManager, nowPlaying } = deps;

  ipcMain.handle("config:get", async () => desktopConfigOf(await loadConfig(), nowPlaying));

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
  ipcMain.handle("updates:download", async () => updateManager.download());
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

  // Runs the API as `written` says. Each toggle calls this after its own write,
  // in write order, so the newest save decides even when an earlier one was
  // still queued when it started.
  async function followNowPlaying(written: Config): Promise<void> {
    if (written.nowPlayingApiEnabled !== true) {
      nowPlaying.close();
      return;
    }
    nowPlaying.token = nowPlayingToken(written.nowPlayingApiToken) || nowPlaying.token;
    // A failure shows as the error in the config this replies with.
    await nowPlaying.start(deps.nowPlayingPort()).catch(() => undefined);
  }

  // Validate a patch, persist it and apply its live side effects. Every field
  // is optional, so Settings can flip one toggle at a time.
  async function applyConfigPatch(
    patch: SavePatch | undefined,
  ): Promise<{ ok: false; error: string } | { ok: true; changed: boolean; written: Config }> {
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
    // Settings sends only the options that changed. They go onto the card as
    // stored when this write lands, so an earlier save still in the queue
    // (from a Settings view since closed, say) isn't overwritten.
    const cardChanges =
      patch?.discordCard && typeof patch.discordCard === "object" ? patch.discordCard : undefined;
    if (typeof patch?.alwaysOnTop === "boolean") {
      writePatch.alwaysOnTop = patch.alwaysOnTop;
    }
    const listening = !!nowPlaying.url;
    if (typeof patch?.nowPlayingApiEnabled === "boolean") {
      // Only saved on once it listens, so a taken port leaves it off.
      if (patch.nowPlayingApiEnabled) {
        try {
          await nowPlaying.start(deps.nowPlayingPort());
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      }
      writePatch.nowPlayingApiEnabled = patch.nowPlayingApiEnabled;
    }
    let written: Config;
    try {
      written = await saveConfigPatch((current) => ({
        ...writePatch,
        ...(cardChanges
          ? { discordCard: normalizeDiscordCard(cardChanges, normalizeDiscordCard(current.discordCard)) }
          : {}),
        // Turning it on keeps the saved token, or saves the one made at launch.
        ...(writePatch.nowPlayingApiEnabled
          ? { nowPlayingApiToken: nowPlayingToken(current.nowPlayingApiToken) || nowPlaying.token }
          : {}),
      }));
    } catch (error) {
      // Not saved on, so not left on.
      if (writePatch.nowPlayingApiEnabled && !listening) nowPlaying.close();
      throw error;
    }
    if (writePatch.discordEnabled !== undefined) {
      configureDiscordPresence({ enabled: writePatch.discordEnabled });
    }
    if (cardChanges) configureDiscordPresence({ card: normalizeDiscordCard(written.discordCard) });
    if (writePatch.alwaysOnTop !== undefined) {
      windows.alwaysOnTop = writePatch.alwaysOnTop;
      windows.mainWindow?.setAlwaysOnTop(windows.alwaysOnTop);
    }
    if (writePatch.nowPlayingApiEnabled !== undefined) await followNowPlaying(written);
    const prev = deps.getBackendUrl();
    if (normalized === null) return { ok: true, changed: false, written };
    deps.setBackendUrl(normalized);
    configureDiscordPresence({ backendUrl: normalized });
    return { ok: true, changed: prev !== normalized, written };
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
    // Answer with the config this write produced. Reading the file again
    // could catch the next queued write mid-way and parse as empty.
    return { ok: true, changed: result.changed, config: desktopConfigOf(result.written, nowPlaying) };
  });

  // Saved first: a token that didn't reach config.json would stop working at
  // the next launch, and the old one would come back.
  ipcMain.handle("now-playing:new-token", async () => {
    const token = newNowPlayingToken();
    const written = await saveConfigPatch({ nowPlayingApiToken: token });
    nowPlaying.token = token;
    return desktopConfigOf(written, nowPlaying);
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

  ipcMain.handle("window:mini-player:panel-anchor", () =>
    windows.miniPlayerPanelAnchor(),
  );

  ipcMain.handle("window:mini-player:panel", (_e, open: boolean) => {
    if (!windows.mainWindow || !windows.isMiniPlayer) {
      return { ok: false, open: false, anchor: windows.miniPlayerPanelAnchor() };
    }
    windows.setMiniPlayerPanel(open === true);
    return {
      ok: true,
      open: windows.miniPlayerPanelOpen,
      anchor: windows.miniPlayerPanelAnchor(),
    };
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

  // The same feed is what the now-playing API reports, so it's kept whether
  // or not Discord status is on.
  ipcMain.handle("discord:activity", async (_e, payload: DiscordActivityPayload) => {
    if (!payload || typeof payload.title !== "string") {
      return { ok: false, error: "invalid payload" };
    }
    nowPlaying.update(payload);
    return pushDiscordActivity(payload);
  });

  ipcMain.handle("discord:clear", async () => {
    nowPlaying.update(null);
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
