import { contextBridge, ipcRenderer } from "electron";

import type { SetupApi } from "./contracts";
export type { SetupApi } from "./contracts";

const api: SetupApi = {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (patch) => ipcRenderer.invoke("config:save", patch),
  setupDone: (opts) => ipcRenderer.invoke("setup:done", opts),
  setupCancel: () => ipcRenderer.invoke("setup:cancel"),
};

contextBridge.exposeInMainWorld("api", api);
