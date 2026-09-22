import * as path from "node:path";
import * as fs from "node:fs";

export interface BuildEnvironment {
  discordClientId?: string;
  updateRepoUrl?: string;
  macUpdateSigned?: boolean;
}

export function readBakedBuildEnv(): BuildEnvironment {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "buildenv.json"), "utf8");
    return JSON.parse(raw) as BuildEnvironment;
  } catch {
    return {};
  }
}
