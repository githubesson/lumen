import type { RendererElectronApi } from "../electron/contracts";
export type { DiscordActivityPayload, FH6StatusPayload, ExportTrackFileItem,
  ExportTrackFilesResult, Tweaks, UpdateBranch, UpdateStatus } from "../electron/contracts";

declare global {
  interface Window {
    electron?: RendererElectronApi;
  }
}
