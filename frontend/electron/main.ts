import { app, BrowserWindow, Menu } from "electron";
import * as path from "node:path";
import {
  DesktopUpdateManager,
  normalizeUpdateBranch,
  parseGitHubRepoUrl,
  type UpdateBranch,
} from "./updater";
import { loadConfig } from "./config";
import {
  configureDiscordPresence,
  teardownDiscordPresence,
} from "./discord-presence";
import { createLocalProxy } from "./local-proxy";
import { readBakedBuildEnv } from "./build-env";
import { createWindowManager } from "./windows";
import { registerIpcHandlers } from "./ipc";
import { installMediaPermissionHandlers } from "./permissions";

export type { Density, Layout, Theme, Tweaks } from "./config";

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

registerIpcHandlers({
  windows,
  localProxy,
  updateManager,
  getBackendUrl: () => backendUrl,
  setBackendUrl: (url) => {
    backendUrl = url;
  },
});

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
    Menu.setApplicationMenu(null);
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
    });
    windows.alwaysOnTop = cfg.alwaysOnTop ?? false;
    const updateBranch =
      normalizeUpdateBranch(cfg.updateBranch) ?? DEFAULT_UPDATE_BRANCH;
    const updateRepoUrl =
      parseGitHubRepoUrl(cfg.updateRepoUrl)?.url ?? DEFAULT_UPDATE_REPO_URL;
    updateManager.configure({ branch: updateBranch, repoUrl: updateRepoUrl });
    await localProxy.start();
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
    void teardownDiscordPresence();
  });
}
