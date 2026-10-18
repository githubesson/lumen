import type { RendererElectronApi } from "./contracts/desktop";
export type { DiscordActivityPayload, DiscordCardOptions, ExportTrackFileItem,
  ExportTrackFilesResult, Tweaks, UpdateBranch, UpdateStatus, DesktopConfig,
  DesktopConfigPatch, MiniPlayerPanelAnchor, ServerTestResult }  from "./contracts/desktop";

declare global {
  interface Window {
    electron?: RendererElectronApi;
  }
}
