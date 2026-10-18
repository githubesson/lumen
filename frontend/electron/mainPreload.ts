import { contextBridge, ipcRenderer } from "electron";
import type { ElectronApi, UpdateStatus } from "../src/contracts/desktop";

const api: ElectronApi = {
  getSignOutIntent: () => ipcRenderer.invoke("auth:intent:get"),
  setSignOutIntent: (signedOut) => ipcRenderer.invoke("auth:intent:set", signedOut),
  isElectron: true,
  platform: process.platform,
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  getConfig: () => ipcRenderer.invoke("config:get"),
  updateConfig: (patch) => ipcRenderer.invoke("config:update", patch),
  testServer: (url) => ipcRenderer.invoke("config:test-server", url),
  newNowPlayingApiToken: () => ipcRenderer.invoke("now-playing:new-token"),
  setTitleBarTheme: (opts) => ipcRenderer.invoke("titlebar:theme", opts),
  setMiniPlayerMode: (enabled) =>
    ipcRenderer.invoke("window:mini-player:set", enabled),
  getMiniPlayerPanelAnchor: () =>
    ipcRenderer.invoke("window:mini-player:panel-anchor"),
  setMiniPlayerPanel: (open) =>
    ipcRenderer.invoke("window:mini-player:panel", open),
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
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
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
