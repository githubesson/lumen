import { app } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, saveConfigPatch } from "./config";

import type { FH6InstallRequest, FH6StatusPayload as FH6Status } from "./contracts";
export type { FH6InstallRequest, FH6StatusPayload as FH6Status } from "./contracts";


export const DEFAULT_FH6_BRIDGE_PORT = 8420;
const execFileAsync = promisify(execFile);

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fsp.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fsp.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

export function fh6BridgeUrl(port = DEFAULT_FH6_BRIDGE_PORT): string {
  return `http://127.0.0.1:${port}`;
}

function lumenRadioDistDir(): string {
  const packaged = path.join(process.resourcesPath, "lumen-radio");
  if (fs.existsSync(path.join(packaged, "version.dll"))) return packaged;
  return path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "fh6-spotify-mod",
    "lumen-radio",
    "dist",
  );
}

export function normalizeGameDir(candidate: string): string {
  return path.normalize(candidate.trim().replace(/^"|"$/g, ""));
}

async function findForzaExe(gameDir: string): Promise<string | null> {
  const direct = path.join(gameDir, "forzahorizon6.exe");
  if (await isFile(direct)) return direct;
  try {
    const entries = await fsp.readdir(gameDir, { withFileTypes: true });
    const hit = entries.find(
      (entry) =>
        entry.isFile() &&
        /\.exe$/i.test(entry.name) &&
        /forza/i.test(entry.name) &&
        /horizon/i.test(entry.name) &&
        /6/.test(entry.name),
    );
    return hit ? path.join(gameDir, hit.name) : null;
  } catch {
    return null;
  }
}

async function discoverFH6Candidates(): Promise<string[]> {
  const config = await loadConfig();
  const candidates = new Set<string>();
  if (config.fh6GameDir) candidates.add(normalizeGameDir(config.fh6GameDir));

  const roots = new Set<string>();
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    roots.add(`${letter}:\\XboxGames`);
    roots.add(`${letter}:\\SteamLibrary\\steamapps\\common`);
    roots.add(`${letter}:\\Program Files (x86)\\Steam\\steamapps\\common`);
  }
  roots.add(path.join(process.env.ProgramFiles ?? "C:\\Program Files", "WindowsApps"));

  for (const root of roots) {
    if (!(await isDirectory(root))) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/forza.*horizon.*6|fh6/i.test(entry.name)) continue;
      const base = path.join(root, entry.name);
      const content = path.join(base, "Content");
      if (await findForzaExe(content)) candidates.add(content);
      if (await findForzaExe(base)) candidates.add(base);
    }
  }

  try {
    const { stdout } = await execFileAsync("reg", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "/s",
      "/f",
      "Forza Horizon 6",
      "/d",
    ]);
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/InstallLocation\s+REG_\w+\s+(.+)$/i);
      if (!match) continue;
      const install = normalizeGameDir(match[1]);
      const content = path.join(install, "Content");
      if (await findForzaExe(content)) candidates.add(content);
      if (await findForzaExe(install)) candidates.add(install);
    }
  } catch {
    // Registry coverage varies between Store, Steam, and portable installs.
  }

  return Array.from(candidates);
}

async function findEntry(
  root: string,
  pattern: RegExp,
  maxDepth: number,
  kind: "file" | "directory",
): Promise<string | null> {
  if (maxDepth < 0 || !(await isDirectory(root))) return null;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const isMatchKind = kind === "file" ? entry.isFile() : entry.isDirectory();
    if (isMatchKind && pattern.test(entry.name)) return path.join(root, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hit = await findEntry(path.join(root, entry.name), pattern, maxDepth - 1, kind);
    if (hit) return hit;
  }
  return null;
}

function findFile(root: string, pattern: RegExp, maxDepth: number) {
  return findEntry(root, pattern, maxDepth, "file");
}

function findDirectory(root: string, pattern: RegExp, maxDepth: number) {
  return findEntry(root, pattern, maxDepth, "directory");
}

async function hasRadioMedia(gameDir: string): Promise<boolean> {
  return !!(await findFile(path.join(gameDir, "media"), /^RadioInfo_EN\.xml$/i, 4));
}

export async function fh6Status(): Promise<FH6Status> {
  const config = await loadConfig();
  const candidates = await discoverFH6Candidates();
  const gameDir = normalizeGameDir(config.fh6GameDir || candidates[0] || "");
  const dist = lumenRadioDistDir();
  const gameDirExists = !!gameDir && (await isDirectory(gameDir));
  return {
    enabled: config.fh6RadioEnabled === true,
    gameDir,
    bridgeUrl: fh6BridgeUrl(config.fh6BridgePort ?? DEFAULT_FH6_BRIDGE_PORT),
    gameDirExists,
    exeFound: gameDirExists && !!(await findForzaExe(gameDir)),
    bridgeInstalled: gameDirExists && (await isFile(path.join(gameDir, "version.dll"))),
    configInstalled:
      gameDirExists && (await isFile(path.join(gameDir, "fh6-radio", "config.toml"))),
    mediaInstalled: gameDirExists && (await hasRadioMedia(gameDir)),
    packagedModAvailable: await isFile(path.join(dist, "version.dll")),
    candidates,
  };
}

async function backupAndCopy(source: string, destination: string): Promise<void> {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  if (await isFile(destination)) await fsp.copyFile(destination, `${destination}.bak`);
  await fsp.copyFile(source, destination);
}

async function copyTreeWithBackup(sourceRoot: string, destinationRoot: string): Promise<number> {
  let count = 0;
  async function walk(source: string): Promise<void> {
    const entries = await fsp.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const relative = path.relative(sourceRoot, sourcePath);
      const destinationPath = path.join(destinationRoot, relative);
      if (entry.isDirectory()) {
        await walk(sourcePath);
      } else if (entry.isFile()) {
        await backupAndCopy(sourcePath, destinationPath);
        count += 1;
      }
    }
  }
  await walk(sourceRoot);
  return count;
}

async function extractZip(zipPath: string): Promise<string> {
  const temporary = path.join(app.getPath("temp"), `lumen-radio-media-${Date.now()}`);
  await fsp.mkdir(temporary, { recursive: true });
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
    zipPath,
    temporary,
  ]);
  return temporary;
}

async function mediaRootFromSource(source: string): Promise<string> {
  const clean = normalizeGameDir(source);
  const root = /\.zip$/i.test(clean) ? await extractZip(clean) : clean;
  if (!(await isDirectory(root))) throw new Error("Media source is not a folder or ZIP");
  const mediaDir = await findDirectory(root, /^media$/i, 5);
  if (mediaDir) return mediaDir;
  const radioInfo = await findFile(root, /^RadioInfo_EN\.xml$/i, 6);
  if (!radioInfo) throw new Error("No RadioInfo_EN.xml found in media source");
  return path.dirname(path.dirname(radioInfo));
}

async function brandInstalledMedia(mediaDir: string): Promise<number> {
  const replacements: Array<[RegExp, string]> = [
    [/FH6 Universal Radio/gi, "Lumen Radio"],
    [/Universal Radio/gi, "Lumen Radio"],
    [/Spotify Radio/gi, "Lumen Radio"],
    [/Spotify/gi, "Lumen"],
    [/Jellyfin/gi, "Lumen"],
    [/YouTube Music/gi, "Lumen"],
    [/Local Files/gi, "Lumen"],
  ];
  let changed = 0;
  async function walk(directory: string): Promise<void> {
    if (!(await isDirectory(directory))) return;
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile() || !/\.(xml|json|ini|txt)$/i.test(entry.name)) continue;
      const before = await fsp.readFile(entryPath, "utf8");
      let after = before;
      for (const [pattern, value] of replacements) after = after.replace(pattern, value);
      if (/RadioInfo_[A-Z]+\.xml$/i.test(entry.name)) after = normalizeLumenRadioInfo(after);
      if (after !== before) {
        await fsp.writeFile(entryPath, after, "utf8");
        changed += 1;
      }
    }
  }
  await walk(mediaDir);
  return changed;
}

function normalizeLumenRadioInfo(xml: string): string {
  const carrier = "HZ6_R9_PeterBroderick_EyesClosedandTraveling";
  return xml.replace(
    /(<RadioStation\b[^>]*Name="Streamer Mode"[^>]*>)([\s\S]*?)(<\/RadioStation>)/g,
    (_match, open: string, body: string, close: string) => {
      const normalized = body.replace(
        /<PlayList\b([^>]*)>[\s\S]*?<\/PlayList>/g,
        (_playlist, attrs: string) => {
          if (/Type="ShortStinger"/i.test(attrs)) return `<PlayList${attrs} />`;
          return `<PlayList${attrs}>\n        <Entry Name="${carrier}" />\n      </PlayList>`;
        },
      );
      return `${open}${normalized}${close}`;
    },
  ).replace(
    /(<RadioStation\b(?![^>]*Name="Streamer Mode")[^>]*>)([\s\S]*?)(<\/RadioStation>)/g,
    (_match, open: string, body: string, close: string) => {
      const withoutCarrier = body.replace(
        new RegExp(`\\s*<Entry\\s+Name="${carrier}"\\s*/>`, "g"),
        "",
      );
      return `${open}${withoutCarrier}${close}`;
    },
  );
}

async function patchLumenRadioConfig(configPath: string): Promise<void> {
  let raw = "";
  try {
    raw = await fsp.readFile(configPath, "utf8");
  } catch {
    return;
  }
  const stereoLine = "force_stereo_audio   = false       # auto: stereo for FMOD 2D channels, mono if FMOD reports 3D";
  const guardLine = "spatial_guard_enabled = false      # off by default; enable only while testing FH6 tonal-route issues";
  const headroomLine = "spatial_guard_headroom = 1.0       # lower = safer but flatter; 1.0 leaves levels unchanged";
  let next = raw;
  if (/^\s*force_stereo_audio\s*=/m.test(next)) {
    next = next.replace(/^\s*force_stereo_audio\s*=.*$/m, stereoLine);
  } else if (/^\s*\[playback\]\s*$/m.test(next)) {
    next = next.replace(/^\s*\[playback\]\s*$/m, `[playback]\n${stereoLine}`);
  } else {
    next = `${next.trimEnd()}\n\n[playback]\n${stereoLine}\n`;
  }
  if (/^\s*spatial_guard_enabled\s*=/m.test(next)) {
    next = next.replace(/^\s*spatial_guard_enabled\s*=.*$/m, guardLine);
  } else {
    next = next.replace(/^\s*force_stereo_audio\s*=.*$/m, `${guardLine}\n${headroomLine}\n$&`);
  }
  if (/^\s*spatial_guard_headroom\s*=/m.test(next)) {
    next = next.replace(/^\s*spatial_guard_headroom\s*=.*$/m, headroomLine);
  } else {
    next = next.replace(/^\s*spatial_guard_enabled\s*=.*$/m, `$&\n${headroomLine}`);
  }
  if (next !== raw) await fsp.writeFile(configPath, next, "utf8");
}

export async function installFH6Radio(request: FH6InstallRequest): Promise<{
  ok: boolean;
  status: FH6Status;
  copiedFiles: number;
  brandedFiles: number;
}> {
  const current = await loadConfig();
  const gameDir = normalizeGameDir(request.gameDir || current.fh6GameDir || "");
  if (!gameDir) throw new Error("Choose the FH6 install folder first");
  if (!(await isDirectory(gameDir))) throw new Error("Game folder does not exist");
  if (!(await findForzaExe(gameDir))) {
    throw new Error("That folder does not contain forzahorizon6.exe");
  }
  const dist = lumenRadioDistDir();
  if (!(await isFile(path.join(dist, "version.dll")))) {
    throw new Error("Bundled Lumen Radio build is missing version.dll");
  }
  await backupAndCopy(path.join(dist, "version.dll"), path.join(gameDir, "version.dll"));
  const configDestination = path.join(gameDir, "fh6-radio", "config.toml");
  if (!(await isFile(configDestination))) {
    await backupAndCopy(path.join(dist, "fh6-radio", "config.toml"), configDestination);
  }
  await patchLumenRadioConfig(configDestination);

  let copiedFiles = 1;
  const mediaDestination = path.join(gameDir, "media");
  if (!request.skipMedia) {
    if (!request.mediaSource) throw new Error("Choose a radio media ZIP or folder");
    const mediaRoot = await mediaRootFromSource(request.mediaSource);
    copiedFiles += await copyTreeWithBackup(mediaRoot, mediaDestination);
  }
  const brandedFiles = await brandInstalledMedia(mediaDestination);
  await saveConfigPatch({ fh6GameDir: gameDir, fh6RadioEnabled: true });
  return { ok: true, status: await fh6Status(), copiedFiles, brandedFiles };
}
