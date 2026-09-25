import { useSyncExternalStore } from "react";
import type { DesktopConfigPatch, SetupConfig } from "../electron";
import { electron } from "./platform";

/**
 * The desktop app's own settings (server, Discord, window, FH6 radio), shared
 * by everything that shows or changes them, so a toggle in Settings is seen
 * at once by the sidebar and the FH6 page. Null on the web and until the
 * first load resolves.
 */
let config: SetupConfig | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: SetupConfig) {
  config = next;
  for (const listener of listeners) listener();
}

function load() {
  const getConfig = electron()?.getConfig;
  if (!getConfig || loading) return;
  loading = getConfig()
    .then((next) => {
      // A save that finished first is newer than this read.
      if (!config) publish(next);
    })
    .catch(() => {
      // Retry on the next subscriber rather than staying empty for good.
      loading = null;
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  load();
  return () => {
    listeners.delete(listener);
  };
}

export function useDesktopConfig(): SetupConfig | null {
  return useSyncExternalStore(subscribe, () => config, () => null);
}

/** Whether this desktop build can change its settings from inside the app. */
export function canUpdateDesktopConfig(): boolean {
  return !!electron()?.updateConfig;
}

export async function updateDesktopConfig(
  patch: DesktopConfigPatch,
): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const updateConfig = electron()?.updateConfig;
  if (!updateConfig) return { ok: false, error: "This version of the app can't change settings here." };
  const result = await updateConfig(patch);
  if (!result.ok) return result;
  publish(result.config);
  return { ok: true, changed: result.changed };
}
