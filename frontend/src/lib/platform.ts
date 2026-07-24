import type { DiscordActivityPayload } from "../electron";
import type { ExportTrackFileItem } from "../electron";
import type { Tweaks as ElectronTweaks } from "../electron";

type ElectronApi = NonNullable<Window["electron"]>;

/**
 * Single platform seam. The Electron preload bridge (or undefined on web), plus
 * narrow capability helpers — so components ask for a capability instead of
 * poking `window.electron?.X` inline in a dozen places.
 *
 * Resolved on every access rather than captured at module-eval time. The
 * preload does run before the bundle today, but freezing the bridge and the
 * capability flags at first import made that an invisible ordering dependency
 * that would fail silently — and untraceably — if it ever stopped holding.
 */
export function electron(): ElectronApi | undefined {
  return typeof window !== "undefined" ? window.electron : undefined;
}

/** True when running inside the Electron desktop shell. */
export function isElectron(): boolean {
  return !!electron();
}

/** Whether the desktop shell can toggle the compact mini-player window. */
export function canSetMiniPlayer(): boolean {
  return !!electron()?.setMiniPlayerMode;
}

/** Whether the desktop shell can export many track streams into a chosen folder. */
export function canExportTrackFiles(): boolean {
  return !!electron()?.exportTrackFiles;
}

export function setMiniPlayerMode(enabled: boolean) {
  return (
    electron()?.setMiniPlayerMode?.(enabled) ??
    Promise.resolve({ ok: false, miniPlayer: false })
  );
}

export function setTitleBarTheme(opts: { color: string; symbolColor: string }) {
  return electron()?.setTitleBarTheme?.(opts) ?? Promise.resolve({ ok: false });
}

export function pushDiscordActivity(payload: DiscordActivityPayload) {
  return electron()?.setDiscordActivity?.(payload);
}

export function clearDiscordActivity() {
  return electron()?.clearDiscordActivity?.();
}

export function getDesktopConfig() {
  return electron()?.getConfig?.();
}

export async function openExternal(url: string) {
  const bridge = electron();
  if (bridge?.openExternal) return bridge.openExternal(url);
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  return opened
    ? { ok: true }
    : { ok: false, error: "The browser blocked the authorization window." };
}

export function getFH6Status() {
  return electron()?.getFH6Status?.();
}

export function chooseFH6GameDir() {
  return electron()?.chooseFH6GameDir?.();
}

export function chooseFH6MediaSource() {
  return electron()?.chooseFH6MediaSource?.();
}

export function installFH6Radio(opts: {
  gameDir?: string;
  mediaSource?: string;
  skipMedia?: boolean;
}) {
  return electron()?.installFH6Radio?.(opts);
}

export function syncFH6Session() {
  return electron()?.syncFH6Session?.();
}

export function exportTrackFiles(items: ExportTrackFileItem[]) {
  return electron()?.exportTrackFiles?.(items);
}

export function getTweaks() {
  return (
    electron()?.getTweaks?.() ??
    Promise.resolve({ tweaks: {} as Partial<ElectronTweaks>, audioSinkId: "" })
  );
}

export function saveTweaks(payload: {
  tweaks?: Partial<ElectronTweaks>;
  audioSinkId?: string;
}) {
  return electron()?.saveTweaks?.(payload) ?? Promise.resolve({ ok: false });
}
