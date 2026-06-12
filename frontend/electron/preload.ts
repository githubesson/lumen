import { contextBridge, ipcRenderer } from "electron";

export interface SetupApi {
  getConfig(): Promise<{
    backendUrl: string;
    discordEnabled: boolean;
    alwaysOnTop: boolean;
    fh6RadioEnabled: boolean;
    fh6GameDir: string;
    fh6BridgePort: number;
  }>;
  saveConfig(
    patch: {
      backendUrl: string;
      discordEnabled?: boolean;
      alwaysOnTop?: boolean;
      fh6RadioEnabled?: boolean;
      fh6GameDir?: string;
      fh6BridgePort?: number;
    },
  ): Promise<{ ok: boolean; error?: string; changed?: boolean }>;
  setupDone(opts?: { clearSession?: boolean }): Promise<{ ok: boolean }>;
  setupCancel(): Promise<{ ok: boolean }>;
}

const api: SetupApi = {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (patch) => ipcRenderer.invoke("config:save", patch),
  setupDone: (opts) => ipcRenderer.invoke("setup:done", opts),
  setupCancel: () => ipcRenderer.invoke("setup:cancel"),
};

contextBridge.exposeInMainWorld("api", api);
