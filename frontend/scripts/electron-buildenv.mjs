// Build step: bake build-time config into electron/build/buildenv.json
// (gitignored, packaged into the app). Runs first in `electron:compile`.
//
// DISCORD_CLIENT_ID is taken from the environment, falling back to ./.env
// (copy .env.example). Missing everywhere → empty file, Rich Presence off.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(projectRoot, "electron", "build");
const outFile = path.join(outDir, "buildenv.json");

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

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify({ discordClientId }, null, 2)}\n`);
console.log(
  `buildenv: wrote electron/build/buildenv.json (discordClientId ${
    discordClientId ? "set" : "blank — Rich Presence off"
  })`,
);
