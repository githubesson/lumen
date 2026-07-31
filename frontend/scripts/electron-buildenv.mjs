// Build step: bake build-time config into electron/build/buildenv.json
// (gitignored, packaged into the app). Runs first in `electron:compile`.
//
// Values are taken from the environment, falling back to ./.env (copy
// .env.example). The update repository has a safe project default so every
// packaged build knows where to check unless the build explicitly overrides it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(projectRoot, "electron", "build");
const outFile = path.join(outDir, "buildenv.json");
const DEFAULT_UPDATE_REPO_URL = "https://github.com/githubesson/lumen";

function readDotEnvValue(key) {
  try {
    const line = fs
      .readFileSync(path.join(projectRoot, ".env"), "utf8")
      .split(/\r?\n/)
      .find((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (!line) return "";
    return line
      .slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}

const discordClientId =
  process.env.DISCORD_CLIENT_ID?.trim() || readDotEnvValue("DISCORD_CLIENT_ID");
const updateRepoUrl =
  process.env.UPDATE_REPO_URL?.trim() ||
  readDotEnvValue("UPDATE_REPO_URL") ||
  DEFAULT_UPDATE_REPO_URL;
// macOS's native updater requires the installed app and the replacement to be
// signed. The existing release setup signs only when CSC_NAME is provided.
const macUpdateSigned = Boolean(process.env.CSC_NAME?.trim());

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  outFile,
  `${JSON.stringify({ discordClientId, updateRepoUrl, macUpdateSigned }, null, 2)}\n`,
);
console.log(
  `buildenv: wrote electron/build/buildenv.json (discordClientId ${
    discordClientId ? "set" : "blank — Rich Presence off"
  }, updateRepoUrl ${updateRepoUrl}, macUpdateSigned ${macUpdateSigned})`,
);
