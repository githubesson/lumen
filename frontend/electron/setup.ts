interface SetupApi {
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

interface Window {
  api: SetupApi;
}

(() => {
  const urlInput = document.getElementById("url") as HTMLInputElement;
  const discordInput = document.getElementById(
    "discordEnabled",
  ) as HTMLInputElement;
  const alwaysOnTopInput = document.getElementById(
    "alwaysOnTop",
  ) as HTMLInputElement;
  const fh6RadioInput = document.getElementById(
    "fh6RadioEnabled",
  ) as HTMLInputElement;
  const errorEl = document.getElementById("error") as HTMLDivElement;
  const saveBtn = document.getElementById("save") as HTMLButtonElement;
  const cancelBtn = document.getElementById("cancel") as HTMLButtonElement;

  const api = (window as unknown as { api: SetupApi }).api;

  let originalUrl = "";

  void (async () => {
    const cfg = await api.getConfig();
    originalUrl = cfg.backendUrl ?? "";
    if (originalUrl) urlInput.value = originalUrl;
    discordInput.checked = cfg.discordEnabled !== false;
    alwaysOnTopInput.checked = cfg.alwaysOnTop === true;
    fh6RadioInput.checked = cfg.fh6RadioEnabled === true;
    urlInput.focus();
    urlInput.select();
  })();

  async function doSave(): Promise<void> {
    errorEl.textContent = "";
    const raw = urlInput.value.trim();
    if (!raw) {
      errorEl.textContent = "Server URL is required";
      return;
    }
    saveBtn.disabled = true;
    try {
      const res = await api.saveConfig({
        backendUrl: raw,
        discordEnabled: discordInput.checked,
        alwaysOnTop: alwaysOnTopInput.checked,
        fh6RadioEnabled: fh6RadioInput.checked,
      });
      if (!res.ok) {
        errorEl.textContent = res.error ?? "Save failed";
        saveBtn.disabled = false;
        return;
      }
      await api.setupDone({ clearSession: !!res.changed });
    } catch (e) {
      errorEl.textContent = (e as Error).message;
      saveBtn.disabled = false;
    }
  }

  function doCancel(): void {
    void api.setupCancel();
  }

  saveBtn.addEventListener("click", () => void doSave());
  cancelBtn.addEventListener("click", doCancel);
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void doSave();
    if (e.key === "Escape") doCancel();
  });
})();
