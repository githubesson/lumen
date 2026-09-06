import type { RendererElectronApi } from "./contracts/desktop";
export type { DiscordActivityPayload, FH6StatusPayload, ExportTrackFileItem,
  ExportTrackFilesResult, Tweaks, UpdateBranch, UpdateStatus } from "./contracts/desktop";

declare global {
  interface Window {
    electron?: RendererElectronApi;
  }
}
