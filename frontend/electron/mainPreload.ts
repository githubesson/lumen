import { contextBridge, ipcRenderer } from "electron";

export interface DiscordActivityPayload {
  trackId?: string;
  title: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  durationSec?: number;
  elapsedSec?: number;
  isPlaying: boolean;
}

export interface FH6StatusPayload {
  enabled: boolean;
  gameDir: string;
  bridgeUrl: string;
  gameDirExists: boolean;
  exeFound: boolean;
  bridgeInstalled: boolean;
  configInstalled: boolean;
  mediaInstalled: boolean;
  packagedModAvailable: boolean;
  candidates: string[];
}

export interface ExportTrackFileItem {
  url: string;
  filename: string;
}

export interface ExportTrackFilesResult {
  ok: boolean;
  canceled?: boolean;
  folder?: string;
  saved?: number;
  failed?: number;
  errors?: string[];
  error?: string;
}

export interface ElectronApi {
  isElectron: true;
  platform: NodeJS.Platform;
  openSettings(): Promise<{ ok: boolean }>;
  getConfig(): Promise<{
    backendUrl: string;
    discordEnabled: boolean;
    alwaysOnTop: boolean;
    fh6RadioEnabled: boolean;
    fh6GameDir: string;
    fh6BridgePort: number;
  }>;
  getFH6Status(): Promise<FH6StatusPayload>;
  chooseFH6GameDir(): Promise<{
    ok: boolean;
    gameDir?: string;
    status?: FH6StatusPayload;
  }>;
  chooseFH6MediaSource(): Promise<{ ok: boolean; path?: string }>;
  installFH6Radio(opts: {
    gameDir?: string;
    mediaSource?: string;
    skipMedia?: boolean;
  }): Promise<{
    ok: boolean;
    error?: string;
    copiedFiles?: number;
    brandedFiles?: number;
    status?: FH6StatusPayload;
  }>;
  syncFH6Session(): Promise<{ ok: boolean; error?: string }>;
  setTitleBarTheme(opts: {
    color: string;
    symbolColor: string;
  }): Promise<{ ok: boolean }>;
  setMiniPlayerMode(
    enabled: boolean,
  ): Promise<{ ok: boolean; miniPlayer: boolean }>;
  minimizeWindow(): Promise<{ ok: boolean }>;
  toggleMaximizeWindow(): Promise<{ ok: boolean; maximized?: boolean }>;
  closeWindow(): Promise<{ ok: boolean }>;
  setDiscordActivity(
    payload: DiscordActivityPayload,
  ): Promise<{ ok: boolean; error?: string }>;
  clearDiscordActivity(): Promise<{ ok: boolean }>;
  exportTrackFiles(items: ExportTrackFileItem[]): Promise<ExportTrackFilesResult>;
}

const api: ElectronApi = {
  isElectron: true,
  platform: process.platform,
  openSettings: () => ipcRenderer.invoke("settings:open"),
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
};

contextBridge.exposeInMainWorld("electron", api);

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.setAttribute("data-electron", "true");
});
