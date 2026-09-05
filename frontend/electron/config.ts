import { app } from "electron";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { UpdateBranch } from "./updater";

import type { Tweaks } from "../src/contracts/desktop";
export type { Theme, Density, Layout, Tweaks } from "../src/contracts/desktop";

export interface Config {
  backendUrl?: string;
  discordClientId?: string;
  discordEnabled?: boolean;
  alwaysOnTop?: boolean;
  fh6RadioEnabled?: boolean;
  fh6GameDir?: string;
  fh6BridgePort?: number;
  tweaks?: Partial<Tweaks>;
  audioSinkId?: string;
  updateBranch?: UpdateBranch;
  updateRepoUrl?: string;
}

export interface SavePatch {
  backendUrl?: string;
  discordClientId?: string;
  discordEnabled?: boolean;
  alwaysOnTop?: boolean;
  fh6RadioEnabled?: boolean;
  fh6GameDir?: string;
  fh6BridgePort?: number;
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

export async function saveConfigPatch(patch: Config): Promise<Config> {
  const current = await loadConfig();
  const next: Config = { ...current, ...patch };
  await fsp.mkdir(path.dirname(configPath()), { recursive: true });
  await fsp.writeFile(configPath(), JSON.stringify(next, null, 2));
  return next;
}
