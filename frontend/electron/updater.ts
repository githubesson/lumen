import { app, BrowserWindow } from "electron";
import electronUpdater, {
  type AppUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from "electron-updater";

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

interface GitHubRepo {
  owner: string;
  repo: string;
  url: string;
}

const STARTUP_CHECK_DELAY_MS = 15_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export function normalizeUpdateBranch(value: unknown): UpdateBranch | null {
  return value === "main" || value === "dev" ? value : null;
}

export function parseGitHubRepoUrl(value: unknown): GitHubRepo | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const parts = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    if (parts.length !== 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    if (
      !owner ||
      !repo ||
      !/^[a-z0-9_.-]+$/i.test(owner) ||
      !/^[a-z0-9_.-]+$/i.test(repo)
    ) {
      return null;
    }
    return { owner, repo, url: `https://github.com/${owner}/${repo}` };
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (process.platform === "darwin" && /signature|signed/i.test(message)) {
    return "macOS auto-update requires a signed application.";
  }
  return message || "The update request failed.";
}

export class DesktopUpdateManager {
  private updater: AppUpdater | null = null;
  private preferences: UpdatePreferences;
  private status: UpdateStatus;
  private automaticChecksStarted = false;

  constructor(
    defaultRepoUrl: string,
    defaultBranch: UpdateBranch = "main",
    private readonly macUpdateSigned = false,
  ) {
    const parsedDefault = parseGitHubRepoUrl(defaultRepoUrl);
    const normalizedDefault = parsedDefault?.url ?? "";
    this.preferences = { branch: defaultBranch, repoUrl: normalizedDefault };
    this.status = {
      state: "idle",
      branch: defaultBranch,
      repoUrl: normalizedDefault,
      defaultRepoUrl: normalizedDefault,
      currentVersion: app.getVersion(),
      message: "Updates have not been checked yet.",
      canCheck: false,
      canInstall: false,
    };
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  configure(preferences: UpdatePreferences): UpdateStatus {
    const branch = normalizeUpdateBranch(preferences.branch);
    const repo = parseGitHubRepoUrl(
      preferences.repoUrl || this.status.defaultRepoUrl,
    );
    if (!branch) throw new Error("Update branch must be main or dev.");
    if (!repo) {
      throw new Error(
        "Update repository must be an https://github.com/owner/repo URL.",
      );
    }

    this.preferences = { branch, repoUrl: repo.url };
    const unsupported = this.unsupportedReason();
    if (unsupported) {
      this.setStatus({
        state: "unsupported",
        branch,
        repoUrl: repo.url,
        message: unsupported,
        canCheck: false,
        canInstall: false,
        targetVersion: undefined,
        progress: undefined,
      });
      return this.getStatus();
    }

    const updater = this.ensureUpdater();
    const channel = branch === "dev" ? "dev" : "latest";
    updater.allowPrerelease = branch === "dev";
    updater.channel = channel;
    // Channel changes are an explicit user choice. This permits returning from
    // a newer dev build to the latest stable release as well as opting into dev.
    updater.allowDowngrade = true;
    updater.setFeedURL({
      provider: "github",
      owner: repo.owner,
      repo: repo.repo,
      channel,
    });

    this.setStatus({
      state: "idle",
      branch,
      repoUrl: repo.url,
      message: `Using the ${branch} update branch.`,
      canCheck: true,
      canInstall: false,
      targetVersion: undefined,
      progress: undefined,
    });
    return this.getStatus();
  }

  startAutomaticChecks(): void {
    if (this.automaticChecksStarted || !this.status.canCheck) return;
    this.automaticChecksStarted = true;
    const startup = setTimeout(() => void this.check(), STARTUP_CHECK_DELAY_MS);
    startup.unref();
    const interval = setInterval(() => void this.check(), AUTO_CHECK_INTERVAL_MS);
    interval.unref();
  }

  async check(): Promise<UpdateStatus> {
    if (!this.status.canCheck || !this.updater) return this.getStatus();
    if (this.status.state === "checking" || this.status.state === "downloading") {
      return this.getStatus();
    }
    this.setStatus({
      state: "checking",
      message: `Checking ${this.preferences.branch} for updates…`,
      canInstall: false,
      progress: undefined,
    });
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.setStatus({
        state: "error",
        message: errorMessage(error),
        canInstall: false,
      });
    }
    return this.getStatus();
  }

  install(): UpdateStatus {
    if (!this.updater || this.status.state !== "downloaded") {
      return this.getStatus();
    }
    this.setStatus({
      message: "Installing update and restarting…",
      canInstall: false,
    });
    this.updater.quitAndInstall(false, true);
    return this.getStatus();
  }

  private unsupportedReason(): string | null {
    if (!app.isPackaged) return "Auto-update is available in packaged desktop builds.";
    if (!this.status.defaultRepoUrl) return "No update repository was baked into this build.";
    if (process.platform === "darwin" && !this.macUpdateSigned) {
      return "macOS auto-update requires a signed build; this build is unsigned.";
    }
    if (process.platform === "win32" && process.env.PORTABLE_EXECUTABLE_DIR) {
      return "Portable Windows builds cannot auto-update; install the setup build instead.";
    }
    if (!["win32", "darwin", "linux"].includes(process.platform)) {
      return `Auto-update is not supported on ${process.platform}.`;
    }
    return null;
  }

  private ensureUpdater(): AppUpdater {
    if (this.updater) return this.updater;
    // electron-updater is CommonJS; destructuring the default import is the
    // compatibility path recommended by its TypeScript documentation.
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;

    autoUpdater.on("checking-for-update", () => {
      this.setStatus({ state: "checking", message: "Checking for updates…" });
    });
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.setStatus({
        state: "available",
        targetVersion: info.version,
        message: `Downloading Lumen ${info.version}…`,
        progress: 0,
      });
    });
    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      const percent = Number.isFinite(progress.percent)
        ? Math.max(0, Math.min(100, progress.percent))
        : 0;
      this.setStatus({
        state: "downloading",
        progress: percent,
        message: `Downloading update… ${Math.round(percent)}%`,
      });
    });
    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      this.setStatus({
        state: "up-to-date",
        targetVersion: info.version,
        progress: undefined,
        message: `Lumen ${app.getVersion()} is up to date.`,
      });
    });
    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      this.setStatus({
        state: "downloaded",
        targetVersion: info.version,
        progress: 100,
        message: `Lumen ${info.version} is ready to install.`,
        canInstall: true,
      });
    });
    autoUpdater.on("error", (error: Error) => {
      this.setStatus({
        state: "error",
        message: errorMessage(error),
        canInstall: false,
      });
    });

    this.updater = autoUpdater;
    return autoUpdater;
  }

  private setStatus(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("updates:status", this.status);
      }
    }
  }
}
