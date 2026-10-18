import { app, BrowserWindow, Menu, net } from "electron";
import * as path from "node:path";
import {
  DesktopUpdateManager,
  normalizeUpdateBranch,
  parseGitHubRepoUrl,
  type UpdateBranch,
} from "./updater";
import { loadConfig, saveConfigPatch } from "./config";
import {
  configureDiscordPresence,
  teardownDiscordPresence,
} from "./discord-presence";
import { normalizeDiscordCard } from "./discord-card";
import { createLocalProxy } from "./local-proxy";
import {
  createNowPlayingServer,
  DEFAULT_NOW_PLAYING_PORT,
  newNowPlayingToken,
  nowPlayingPort,
  nowPlayingToken,
} from "./now-playing";
import { readBakedBuildEnv } from "./build-env";
import { createWindowManager } from "./windows";
import { registerIpcHandlers } from "./ipc";
import { installMediaPermissionHandlers } from "./permissions";

const DIST_DIR = path.join(__dirname, "..", "..", "dist");
const FALLBACK_UPDATE_REPO_URL = "https://github.com/githubesson/lumen";
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

let backendUrl = "";
const localProxy = createLocalProxy({
  distDir: DIST_DIR,
  getBackendUrl: () => backendUrl,
});
const windows = createWindowManager({ localProxy, updateManager });
const nowPlaying = createNowPlayingServer({
  fetch: (url, init) => net.fetch(url, init),
  appOrigin: () => (localProxy.port ? `http://127.0.0.1:${localProxy.port}` : ""),
});
let nowPlayingApiPort = DEFAULT_NOW_PLAYING_PORT;

registerIpcHandlers({
  windows,
  localProxy,
  updateManager,
  getBackendUrl: () => backendUrl,
  setBackendUrl: (url) => {
    backendUrl = url;
  },
  nowPlaying,
  nowPlayingPort: () => nowPlayingApiPort,
});

// Before ready on purpose: Electron builds its default menu during startup
// unless one was already set, so doing this in whenReady() built one only to
// throw it away. Electron allows setApplicationMenu(null) before ready.
Menu.setApplicationMenu(null);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const { mainWindow } = windows;
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    installMediaPermissionHandlers(localProxy);
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
      card: normalizeDiscordCard(cfg.discordCard),
    });
    windows.alwaysOnTop = cfg.alwaysOnTop ?? false;
    const updateBranch =
      normalizeUpdateBranch(cfg.updateBranch) ?? DEFAULT_UPDATE_BRANCH;
    const updateRepoUrl =
      parseGitHubRepoUrl(cfg.updateRepoUrl)?.url ?? DEFAULT_UPDATE_REPO_URL;
    updateManager.configure({ branch: updateBranch, repoUrl: updateRepoUrl });
    const proxyPort = await localProxy.start(cfg.localProxyPort);
    // Best effort: remembering the port only keeps the origin (and its
    // caches) stable across launches, so a failed write mustn't stop startup.
    if (proxyPort !== cfg.localProxyPort) {
      void saveConfigPatch({ localProxyPort: proxyPort }).catch((error) => {
        console.warn("[config] could not save the local proxy port:", error);
      });
    }
    nowPlayingApiPort = nowPlayingPort(cfg.nowPlayingApiPort);
    // A new token is only saved once the API is on (Settings saves it then).
    const savedToken = nowPlayingToken(cfg.nowPlayingApiToken);
    nowPlaying.token = savedToken || newNowPlayingToken();
    // A port another app holds shows in Settings rather than stopping startup.
    if (cfg.nowPlayingApiEnabled === true) {
      if (!savedToken) {
        void saveConfigPatch({ nowPlayingApiToken: nowPlaying.token }).catch((error) => {
          console.warn("[config] could not save the now-playing token:", error);
        });
      }
      await nowPlaying.start(nowPlayingApiPort).catch((error: Error) => {
        console.warn("[now-playing]", error.message);
      });
    }
    // With no server yet the renderer shows its first-run setup.
    await windows.openMain();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void windows.openMain();
  });

  app.on("before-quit", () => {
    localProxy.close();
    nowPlaying.close();
    void teardownDiscordPresence();
  });
}
