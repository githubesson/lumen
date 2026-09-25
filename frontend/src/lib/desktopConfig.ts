import { useSyncExternalStore } from "react";
import type { DesktopConfig, DesktopConfigPatch, ServerTestResult } from "../electron";
import { electron } from "./platform";

/**
 * The desktop app's own settings (server, Discord, window, FH6 radio), shared
 * by everything that shows or changes them, so a toggle in Settings is seen
 * at once by the sidebar and the FH6 page. Null on the web and until the
 * first load resolves.
 */
let config: DesktopConfig | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: DesktopConfig) {
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

// Start reading at boot, while auth resolves, so the sidebar's desktop-only
// items are known by the time it first paints instead of popping in.
load();

function subscribe(listener: () => void) {
  listeners.add(listener);
  load();
  return () => {
    listeners.delete(listener);
  };
}

export function useDesktopConfig(): DesktopConfig | null {
  return useSyncExternalStore(subscribe, () => config, () => null);
}

/** Save settings; a new server reloads the window onto its sign-in page. */
export async function updateDesktopConfig(
  patch: DesktopConfigPatch,
): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const desktop = electron();
  if (!desktop) return { ok: false, error: "Only the desktop app has these settings." };
  const result = await desktop.updateConfig(patch);
  if (!result.ok) return result;
  publish(result.config);
  return { ok: true, changed: result.changed };
}

/** Check there's a Lumen server at `address`; resolves to its origin. */
export function testDesktopServer(address: string): Promise<ServerTestResult> {
  const desktop = electron();
  if (!desktop) return Promise.resolve({ ok: false, error: "Only the desktop app connects to a server." });
  return desktop.testServer(address);
}
