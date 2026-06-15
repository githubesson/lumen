import type { DiscordActivityPayload } from "../electron";
import type { ExportTrackFileItem } from "../electron";

type ElectronApi = NonNullable<Window["electron"]>;

/**
 * Single platform seam. The Electron preload bridge (or undefined on web),
 * captured once, plus narrow capability helpers — so components ask for a
 * capability instead of poking `window.electron?.X` inline in a dozen places.
 */
export const electron: ElectronApi | undefined =
  typeof window !== "undefined" ? window.electron : undefined;

/** True when running inside the Electron desktop shell. */
export const isElectron = !!electron;

/** Whether the desktop shell can toggle the compact mini-player window. */
export const canSetMiniPlayer = !!electron?.setMiniPlayerMode;

/** Whether the desktop shell can export many track streams into a chosen folder. */
export const canExportTrackFiles = !!electron?.exportTrackFiles;

export function setMiniPlayerMode(enabled: boolean) {
  return (
    electron?.setMiniPlayerMode?.(enabled) ??
    Promise.resolve({ ok: false, miniPlayer: false })
  );
}

export function setTitleBarTheme(opts: { color: string; symbolColor: string }) {
  return electron?.setTitleBarTheme?.(opts) ?? Promise.resolve({ ok: false });
}

export function pushDiscordActivity(payload: DiscordActivityPayload) {
  return electron?.setDiscordActivity?.(payload);
}

export function clearDiscordActivity() {
  return electron?.clearDiscordActivity?.();
}

export function getDesktopConfig() {
  return electron?.getConfig?.();
}

export function getFH6Status() {
  return electron?.getFH6Status?.();
}

export function chooseFH6GameDir() {
  return electron?.chooseFH6GameDir?.();
}

export function chooseFH6MediaSource() {
  return electron?.chooseFH6MediaSource?.();
}

export function installFH6Radio(opts: {
  gameDir?: string;
  mediaSource?: string;
  skipMedia?: boolean;
}) {
  return electron?.installFH6Radio?.(opts);
}

export function syncFH6Session() {
  return electron?.syncFH6Session?.();
}

export function exportTrackFiles(items: ExportTrackFileItem[]) {
  return electron?.exportTrackFiles?.(items);
}
