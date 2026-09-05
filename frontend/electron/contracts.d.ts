// Shared IPC declarations only: safe to reference from the main process,
// sandboxed preloads, web renderer, and the setup page's classic script.
export type Theme = "light" | "dark";
export type Density = "airy" | "balanced" | "dense";
export type Layout = "compact" | "sidebar" | "wide";

export interface Tweaks {
  theme: Theme;
  depth: number;
  radius: number;
  density: Density;
  layout: Layout;
  /** Ambient accent glow — the album-cover-driven color wash on the app
   *  background, detail headers, mini-player, etc. Turn off for a flat look. */
  glow: boolean;
}

export interface DiscordActivityPayload {
  /** Stable track identifier — main process uses this to decide whether
   *  consecutive pushes describe the same song (and thus whether to preserve
   *  the start timestamp). Title/artist/album aren't reliable: re-uploads or
   *  duplicate metadata would falsely match. */
  trackId?: string;
  /** Track title shown as "details" on the Discord card. */
  title: string;
  /** Artist shown as "state" (renders as "by ARTIST"). */
  artist?: string;
  album?: string;
  /** Publicly reachable URL to cover art (served via the backend). */
  coverUrl?: string;
  /** Track duration in seconds — used to draw the progress bar end. */
  durationSec?: number;
  /** Seconds elapsed within the track — used to draw the progress bar start. */
  elapsedSec?: number;
  /** When false, presence shows "paused" style (no timestamps). */
  isPlaying: boolean;
}

export interface FH6StatusPayload {
  enabled: boolean;
  gameDir: string;
  bridgeUrl: string;
  gameDirExists: boolean;
  exeFound: boolean;
  bridgeInstalled: boolean;
  configInstalled: boolean;
  mediaInstalled: boolean;
  packagedModAvailable: boolean;
  candidates: string[];
}

export interface ExportTrackFileItem {
  url: string;
  filename: string;
}

export interface ExportTrackFilesResult {
  ok: boolean;
  canceled?: boolean;
  folder?: string;
  saved?: number;
  failed?: number;
  errors?: string[];
  error?: string;
}

export type UpdateBranch = "main" | "dev";

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error"
  | "unsupported";

export interface UpdateStatus {
  state: UpdateState;
  branch: UpdateBranch;
  repoUrl: string;
  defaultRepoUrl: string;
  currentVersion: string;
  targetVersion?: string;
  progress?: number;
  message: string;
  canCheck: boolean;
  canInstall: boolean;
}

export interface UpdatePreferences {
  branch: UpdateBranch;
  repoUrl: string;
}

export interface SetupConfig {
  backendUrl: string;
  discordEnabled: boolean;
  alwaysOnTop: boolean;
  fh6RadioEnabled: boolean;
  fh6GameDir: string;
  fh6BridgePort: number;
}
export interface SetupDoneOpts {
  clearSession?: boolean;
}
export interface FH6InstallRequest {
  gameDir?: string;
  mediaSource?: string;
  skipMedia?: boolean;
}

export interface SetupApi {
  getConfig(): Promise<SetupConfig>;
  saveConfig(
    patch: Pick<SetupConfig, "backendUrl"> &
      Partial<Omit<SetupConfig, "backendUrl">>,
  ): Promise<{ ok: boolean; error?: string; changed?: boolean }>;
  setupDone(opts?: SetupDoneOpts): Promise<{ ok: boolean }>;
  setupCancel(): Promise<{ ok: boolean }>;
}

export interface ElectronApi {
  getSignOutIntent(): Promise<boolean>;
  setSignOutIntent(signedOut: boolean): Promise<void>;
  isElectron: true;
  platform: string;
  openSettings(): Promise<{ ok: boolean }>;
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
  getConfig(): Promise<SetupConfig>;
  getFH6Status(): Promise<FH6StatusPayload>;
  chooseFH6GameDir(): Promise<{
    ok: boolean;
    gameDir?: string;
    status?: FH6StatusPayload;
  }>;
  chooseFH6MediaSource(): Promise<{ ok: boolean; path?: string }>;
  installFH6Radio(opts: FH6InstallRequest): Promise<{
    ok: boolean;
    error?: string;
    copiedFiles?: number;
    brandedFiles?: number;
    status?: FH6StatusPayload;
  }>;
  syncFH6Session(): Promise<{ ok: boolean; error?: string }>;
  setTitleBarTheme(opts: {
    color: string;
    symbolColor: string;
  }): Promise<{ ok: boolean }>;
  setMiniPlayerMode(
    enabled: boolean,
  ): Promise<{ ok: boolean; miniPlayer: boolean }>;
  minimizeWindow(): Promise<{ ok: boolean }>;
  toggleMaximizeWindow(): Promise<{ ok: boolean; maximized?: boolean }>;
  closeWindow(): Promise<{ ok: boolean }>;
  setDiscordActivity(
    payload: DiscordActivityPayload,
  ): Promise<{ ok: boolean; error?: string }>;
  clearDiscordActivity(): Promise<{ ok: boolean }>;
  exportTrackFiles(
    items: ExportTrackFileItem[],
  ): Promise<ExportTrackFilesResult>;
  getTweaks(): Promise<{ tweaks: Partial<Tweaks>; audioSinkId: string }>;
  saveTweaks(payload: {
    tweaks?: Partial<Tweaks>;
    audioSinkId?: string;
  }): Promise<{ ok: boolean }>;
  getUpdateStatus(): Promise<UpdateStatus>;
  saveUpdateConfig(
    payload: UpdatePreferences,
  ): Promise<{ ok: boolean; status?: UpdateStatus; error?: string }>;
  checkForUpdates(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
}

// Older desktop builds may not expose these methods to a newer web renderer.
type OptionalRendererMethods =
  | "setDiscordActivity"
  | "clearDiscordActivity"
  | "exportTrackFiles"
  | "getTweaks"
  | "saveTweaks"
  | "getUpdateStatus"
  | "saveUpdateConfig"
  | "checkForUpdates"
  | "installUpdate"
  | "onUpdateStatus";
export type RendererElectronApi = Omit<ElectronApi, OptionalRendererMethods> &
  Partial<Pick<ElectronApi, OptionalRendererMethods>>;
