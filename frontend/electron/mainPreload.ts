import { contextBridge, ipcRenderer } from "electron";
import type { UpdateStatus } from "./contracts";

import type { ElectronApi } from "./contracts";
export type { ElectronApi, Tweaks, DiscordActivityPayload, FH6StatusPayload,
  ExportTrackFileItem, ExportTrackFilesResult } from "./contracts";

const api: ElectronApi = {
  getSignOutIntent: () => ipcRenderer.invoke("auth:intent:get"),
  setSignOutIntent: (signedOut) => ipcRenderer.invoke("auth:intent:set", signedOut),
  isElectron: true,
  platform: process.platform,
  openSettings: () => ipcRenderer.invoke("settings:open"),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  getConfig: () => ipcRenderer.invoke("config:get"),
  getFH6Status: () => ipcRenderer.invoke("fh6:status"),
  chooseFH6GameDir: () => ipcRenderer.invoke("fh6:choose-game-dir"),
  chooseFH6MediaSource: () => ipcRenderer.invoke("fh6:choose-media-source"),
  installFH6Radio: (opts) => ipcRenderer.invoke("fh6:install", opts),
  syncFH6Session: () => ipcRenderer.invoke("fh6:sync-session"),
  setTitleBarTheme: (opts) => ipcRenderer.invoke("titlebar:theme", opts),
  setMiniPlayerMode: (enabled) =>
    ipcRenderer.invoke("window:mini-player:set", enabled),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:maximize-toggle"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  setDiscordActivity: (payload) =>
    ipcRenderer.invoke("discord:activity", payload),
  clearDiscordActivity: () => ipcRenderer.invoke("discord:clear"),
  exportTrackFiles: (items) => ipcRenderer.invoke("tracks:export-files", items),
  getTweaks: () => ipcRenderer.invoke("tweaks:get"),
  saveTweaks: (payload) => ipcRenderer.invoke("tweaks:save", payload),
  getUpdateStatus: () => ipcRenderer.invoke("updates:get"),
  saveUpdateConfig: (payload) => ipcRenderer.invoke("updates:save", payload),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) =>
      listener(status);
    ipcRenderer.on("updates:status", handler);
    return () => ipcRenderer.removeListener("updates:status", handler);
  },
};

contextBridge.exposeInMainWorld("electron", api);

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.setAttribute("data-electron", "true");
});
