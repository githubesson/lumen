import { app } from "electron";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { UpdateBranch } from "./updater";

import type { DiscordCardOptions, Tweaks } from "../src/contracts/desktop";
export type { Tweaks } from "../src/contracts/desktop";

export interface Config {
  localProxyPort?: number;
  backendUrl?: string;
  discordClientId?: string;
  discordEnabled?: boolean;
  /** Read through normalizeDiscordCard: the file may be hand-edited. */
  discordCard?: Partial<DiscordCardOptions>;
  alwaysOnTop?: boolean;
  nowPlayingApiEnabled?: boolean;
  /** Not in Settings: set by hand when another app holds the default. */
  nowPlayingApiPort?: number;
  /** Read through nowPlayingToken: the file may be hand-edited. */
  nowPlayingApiToken?: string;
  tweaks?: Partial<Tweaks>;
  audioSinkId?: string;
  updateBranch?: UpdateBranch;
  updateRepoUrl?: string;
}

export interface SavePatch {
  backendUrl?: string;
  discordClientId?: string;
  discordEnabled?: boolean;
  discordCard?: Partial<DiscordCardOptions>;
  alwaysOnTop?: boolean;
  nowPlayingApiEnabled?: boolean;
}

function configPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

export async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await fsp.readFile(configPath(), "utf8")) as Config;
  } catch {
    return {};
  }
}

// Writes are read-modify-write, so two settings saved at once (say, two
// toggles flipped quickly) would drop one without this queue.
let writes: Promise<unknown> = Promise.resolve();

/** `patch` may be worked out from the config it lands on, inside the queue. */
export function saveConfigPatch(patch: Config | ((current: Config) => Config)): Promise<Config> {
  const write = writes.then(async () => {
    const current = await loadConfig();
    const next: Config = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
    await fsp.mkdir(path.dirname(configPath()), { recursive: true });
    await fsp.writeFile(configPath(), JSON.stringify(next, null, 2));
    return next;
  });
  writes = write.catch(() => undefined);
  return write;
}
