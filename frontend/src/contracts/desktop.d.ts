// Shared IPC declarations only: safe to reference from the main process,
// sandboxed preload, and web renderer.
export type Theme = "light" | "dark";
export type Density = "airy" | "balanced" | "dense";
export type Layout = "compact" | "sidebar" | "wide";
/** The window edge that stays put while the mini player's panel is open. */
export type MiniPlayerPanelAnchor = "top" | "bottom";

export interface Tweaks {
  theme: Theme;
  radius: number;
  density: Density;
  layout: Layout;
  /** Home's arrangement on this device; absent for the default. */
  homeBoard?: HomeBoardTweak;
  /** Smooth mix's crossfade on this device, in seconds; absent or 0 is off. */
  smoothMix?: number;
}

/**
 * Home's panels in board order, with their sizes and what they show (see
 * the renderer's homeArrangement.ts, which validates it on read). The first
 * customizing build saved `slots` and `hidden` instead, which still read.
 */
export interface HomeBoardTweak {
  panels?: HomePanelTweak[];
  /** Which default panel filled each of the seven slots (first build). */
  slots?: string[];
  /** Hidden default panels (first build). */
  hidden?: string[];
}

export interface HomePanelTweak {
  id: string;
  kind: string;
  /** Sixths of the wide board. */
  w: number;
  /** Board rows. */
  h: number;
  hidden?: boolean;
  title?: string;
  /** A Replay period key ("last-30", "year:2024"…). */
  period?: string;
  /** A playlist id. */
  playlist?: string;
}

export interface DiscordActivityPayload {
  /** Stable track identifier — main process uses this to decide whether
   *  consecutive pushes describe the same song (and thus whether to preserve
   *  the start timestamp). Title/artist/album aren't reliable: re-uploads or
   *  duplicate metadata would falsely match. */
  trackId?: string;
  /** The card's lines fill {title}, {artist} and {album} from these
   *  (see DiscordCardOptions). */
  title: string;
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

/**
 * How the Discord card reads. Each line is a template where {title},
 * {artist} and {album} fill in; an empty template hides its line.
 */
export interface DiscordCardOptions {
  /** First line, bold. */
  details: string;
  /** Second line. */
  state: string;
  /** Third line, also the cover's tooltip. */
  largeText: string;
  /** What follows "Listening to" in the member list: the app's name or a line. */
  statusName: "app" | "details" | "state";
  /** The album cover, or the Lumen logo when off. */
  cover: boolean;
  /** The play/pause badge on the cover. */
  playState: boolean;
  /** Keep the card up while paused, or clear it until playback resumes. */
  showPaused: boolean;
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

export interface DesktopConfig {
  backendUrl: string;
  discordEnabled: boolean;
  alwaysOnTop: boolean;
  fh6RadioEnabled: boolean;
  fh6GameDir: string;
  fh6BridgePort: number;
  discordCard: DiscordCardOptions;
  /** The local now-playing API for overlays (electron/now-playing.ts). */
  nowPlayingApiEnabled: boolean;
  /** Its origin while it listens, otherwise "". */
  nowPlayingApiUrl: string;
  /** What every request to it must carry, as ?token=. */
  nowPlayingApiToken: string;
  /** Why it couldn't start, otherwise "". */
  nowPlayingApiError: string;
}
export type DesktopConfigPatch = Partial<
  Pick<
    DesktopConfig,
    "backendUrl" | "discordEnabled" | "alwaysOnTop" | "fh6RadioEnabled" | "nowPlayingApiEnabled"
  >
> & {
  /** Only the options that changed; the desktop app merges them onto the saved card. */
  discordCard?: Partial<DiscordCardOptions>;
};
export type DesktopConfigUpdateResult =
  | { ok: false; error: string }
  | {
      ok: true;
      config: DesktopConfig;
      /** The server changed; the window reloads onto its sign-in page. */
      changed: boolean;
    };
/** `url` is the server origin to save, after any redirect. */
export type ServerTestResult = { ok: true; url: string } | { ok: false; error: string };
export interface FH6InstallRequest {
  gameDir?: string;
  mediaSource?: string;
  skipMedia?: boolean;
}

export interface ElectronApi {
  getSignOutIntent(): Promise<boolean>;
  setSignOutIntent(signedOut: boolean): Promise<void>;
  isElectron: true;
  platform: string;
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
  getConfig(): Promise<DesktopConfig>;
  updateConfig(patch: DesktopConfigPatch): Promise<DesktopConfigUpdateResult>;
  testServer(url: string): Promise<ServerTestResult>;
  /** Replace the now-playing API's token; links with the old one stop working. */
  newNowPlayingApiToken(): Promise<DesktopConfig>;
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
  getMiniPlayerPanelAnchor(): Promise<MiniPlayerPanelAnchor>;
  setMiniPlayerPanel(open: boolean): Promise<{
    ok: boolean;
    open: boolean;
    anchor: MiniPlayerPanelAnchor;
  }>;
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
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
}

// Older desktop builds may not expose these methods to a newer web renderer.
type OptionalRendererMethods =
  | "getMiniPlayerPanelAnchor"
  | "setMiniPlayerPanel"
  | "setDiscordActivity"
  | "clearDiscordActivity"
  | "exportTrackFiles"
  | "getTweaks"
  | "saveTweaks"
  | "getUpdateStatus"
  | "saveUpdateConfig"
  | "checkForUpdates"
  | "downloadUpdate"
  | "installUpdate"
  | "onUpdateStatus";
export type RendererElectronApi = Omit<ElectronApi, OptionalRendererMethods> &
  Partial<Pick<ElectronApi, OptionalRendererMethods>>;
