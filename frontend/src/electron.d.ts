export {};

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

declare global {
  interface Window {
    electron?: {
      isElectron: true;
      platform: string;
      openSettings: () => Promise<{ ok: boolean }>;
      getConfig: () => Promise<{
        backendUrl: string;
        discordEnabled: boolean;
        alwaysOnTop: boolean;
        fh6RadioEnabled: boolean;
        fh6GameDir: string;
        fh6BridgePort: number;
      }>;
      getFH6Status: () => Promise<FH6StatusPayload>;
      chooseFH6GameDir: () => Promise<{
        ok: boolean;
        gameDir?: string;
        status?: FH6StatusPayload;
      }>;
      chooseFH6MediaSource: () => Promise<{ ok: boolean; path?: string }>;
      installFH6Radio: (opts: {
        gameDir?: string;
        mediaSource?: string;
        skipMedia?: boolean;
      }) => Promise<{
        ok: boolean;
        error?: string;
        copiedFiles?: number;
        brandedFiles?: number;
        status?: FH6StatusPayload;
      }>;
      syncFH6Session: () => Promise<{ ok: boolean; error?: string }>;
      setTitleBarTheme: (opts: {
        color: string;
        symbolColor: string;
      }) => Promise<{ ok: boolean }>;
      setMiniPlayerMode: (
        enabled: boolean,
      ) => Promise<{ ok: boolean; miniPlayer: boolean }>;
      minimizeWindow: () => Promise<{ ok: boolean }>;
      toggleMaximizeWindow: () => Promise<{ ok: boolean; maximized?: boolean }>;
      closeWindow: () => Promise<{ ok: boolean }>;
      /** Push a new Discord Rich Presence activity. No-op if Discord isn't running or RPC isn't configured. */
      setDiscordActivity?: (
        payload: DiscordActivityPayload,
      ) => Promise<{ ok: boolean; error?: string }>;
      /** Clear the Discord activity (e.g. on logout or paused with no track). */
      clearDiscordActivity?: () => Promise<{ ok: boolean }>;
      exportTrackFiles?: (
        items: ExportTrackFileItem[],
      ) => Promise<ExportTrackFilesResult>;
    };
  }
}
