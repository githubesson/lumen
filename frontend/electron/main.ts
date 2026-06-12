import { app, BrowserWindow, Menu, ipcMain, screen, session, dialog } from "electron";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenDialogOptions, Rectangle } from "electron";

interface Config {
  backendUrl?: string;
  /** Discord application (client) ID from https://discord.com/developers/applications.
   *  Leave blank to disable presence entirely. */
  discordClientId?: string;
  /** Master toggle for Discord Rich Presence. Defaults to true; set false to
   *  skip the RPC integration entirely even when a client ID is present. */
  discordEnabled?: boolean;
  /** Keep the main window pinned above other apps. Defaults to false. */
  alwaysOnTop?: boolean;
  /** Opt-in gate for the FH6/Lumen Radio integration. */
  fh6RadioEnabled?: boolean;
  /** Forza Horizon 6 content directory where forzahorizon6.exe lives. */
  fh6GameDir?: string;
  /** Local bridge port exposed by the injected FH6 DLL. */
  fh6BridgePort?: number;
}

interface SavePatch {
  backendUrl?: string;
  discordClientId?: string;
  discordEnabled?: boolean;
  alwaysOnTop?: boolean;
  fh6RadioEnabled?: boolean;
  fh6GameDir?: string;
  fh6BridgePort?: number;
}

interface DiscordActivityPayload {
  /** Stable track id — used as the primary key for sameness across pushes.
   *  Title/artist/album are unreliable (duplicate metadata, re-uploads). */
  trackId?: string;
  title: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  durationSec?: number;
  elapsedSec?: number;
  isPlaying: boolean;
}

interface SetupDoneOpts {
  clearSession?: boolean;
}

interface FH6InstallRequest {
  gameDir?: string;
  mediaSource?: string;
  skipMedia?: boolean;
}

interface FH6Status {
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

const DIST_DIR = path.join(__dirname, "..", "..", "dist");
const SETUP_FILE = path.join(__dirname, "..", "setup.html");
const SETUP_PRELOAD = path.join(__dirname, "preload.js");
const MAIN_PRELOAD = path.join(__dirname, "mainPreload.js");
const execFileAsync = promisify(execFile);

const DEFAULT_TITLE_BAR_COLOR = "#1a1a1e";
const DEFAULT_SYMBOL_COLOR = "#f2f2f2";
const DEFAULT_FH6_BRIDGE_PORT = 8420;
const NORMAL_MIN_SIZE = { width: 640, height: 480 };
const MINI_PLAYER_SIZE = { width: 780, height: 184 };
let titleBarColor = DEFAULT_TITLE_BAR_COLOR;
let symbolColor = DEFAULT_SYMBOL_COLOR;

let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let proxyServer: http.Server | null = null;
let proxyPort = 0;
let backendUrl = "";
let isMiniPlayer = false;
let normalBounds: Rectangle | null = null;
let alwaysOnTop = false;

function configPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await fsp.readFile(configPath(), "utf8")) as Config;
  } catch {
    return {};
  }
}

async function saveConfigPatch(patch: Config): Promise<Config> {
  const cur = await loadConfig();
  const next: Config = { ...cur, ...patch };
  await fsp.mkdir(path.dirname(configPath()), { recursive: true });
  await fsp.writeFile(configPath(), JSON.stringify(next, null, 2));
  return next;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

function fh6BridgeUrl(port = DEFAULT_FH6_BRIDGE_PORT): string {
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

function normalizeGameDir(p: string): string {
  return path.normalize(p.trim().replace(/^"|"$/g, ""));
}

async function findForzaExe(gameDir: string): Promise<string | null> {
  const direct = path.join(gameDir, "forzahorizon6.exe");
  if (await isFile(direct)) return direct;
  try {
    const entries = await fsp.readdir(gameDir, { withFileTypes: true });
    const hit = entries.find(
      (e) =>
        e.isFile() &&
        /\.exe$/i.test(e.name) &&
        /forza/i.test(e.name) &&
        /horizon/i.test(e.name) &&
        /6/.test(e.name),
    );
    return hit ? path.join(gameDir, hit.name) : null;
  } catch {
    return null;
  }
}

async function discoverFH6Candidates(): Promise<string[]> {
  const cfg = await loadConfig();
  const out = new Set<string>();
  if (cfg.fh6GameDir) out.add(normalizeGameDir(cfg.fh6GameDir));

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
      if (await findForzaExe(content)) out.add(content);
      if (await findForzaExe(base)) out.add(base);
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
      const m = line.match(/InstallLocation\s+REG_\w+\s+(.+)$/i);
      if (!m) continue;
      const install = normalizeGameDir(m[1]);
      const content = path.join(install, "Content");
      if (await findForzaExe(content)) out.add(content);
      if (await findForzaExe(install)) out.add(install);
    }
  } catch {
    // Registry coverage varies between Store, Steam, and portable installs.
  }

  return Array.from(out);
}

async function hasRadioMedia(gameDir: string): Promise<boolean> {
  return !!(await findFile(path.join(gameDir, "media"), /^RadioInfo_EN\.xml$/i, 4));
}

/** Breadth-first search for the first directory entry of `kind` whose name
 *  matches `pattern`: each level is scanned fully before recursing. */
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

async function fh6Status(): Promise<FH6Status> {
  const cfg = await loadConfig();
  const candidates = await discoverFH6Candidates();
  const gameDir = normalizeGameDir(cfg.fh6GameDir || candidates[0] || "");
  const dist = lumenRadioDistDir();
  const gameDirExists = !!gameDir && (await isDirectory(gameDir));
  return {
    enabled: cfg.fh6RadioEnabled === true,
    gameDir,
    bridgeUrl: fh6BridgeUrl(cfg.fh6BridgePort ?? DEFAULT_FH6_BRIDGE_PORT),
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

async function backupAndCopy(src: string, dst: string): Promise<void> {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  if (await isFile(dst)) await fsp.copyFile(dst, `${dst}.bak`);
  await fsp.copyFile(src, dst);
}

async function copyTreeWithBackup(srcRoot: string, dstRoot: string): Promise<number> {
  let count = 0;
  async function walk(src: string): Promise<void> {
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const rel = path.relative(srcRoot, s);
      const d = path.join(dstRoot, rel);
      if (entry.isDirectory()) {
        await walk(s);
      } else if (entry.isFile()) {
        await backupAndCopy(s, d);
        count += 1;
      }
    }
  }
  await walk(srcRoot);
  return count;
}

async function extractZip(zipPath: string): Promise<string> {
  const tmp = path.join(app.getPath("temp"), `lumen-radio-media-${Date.now()}`);
  await fsp.mkdir(tmp, { recursive: true });
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
    zipPath,
    tmp,
  ]);
  return tmp;
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
  async function walk(dir: string): Promise<void> {
    if (!(await isDirectory(dir))) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!entry.isFile() || !/\.(xml|json|ini|txt)$/i.test(entry.name)) continue;
      const before = await fsp.readFile(p, "utf8");
      let after = before;
      for (const [pattern, value] of replacements) after = after.replace(pattern, value);
      if (/RadioInfo_[A-Z]+\.xml$/i.test(entry.name)) after = normalizeLumenRadioInfo(after);
      if (after !== before) {
        await fsp.writeFile(p, after, "utf8");
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

async function installFH6Radio(req: FH6InstallRequest): Promise<{
  ok: boolean;
  status: FH6Status;
  copiedFiles: number;
  brandedFiles: number;
}> {
  const current = await loadConfig();
  const gameDir = normalizeGameDir(req.gameDir || current.fh6GameDir || "");
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
  const configDst = path.join(gameDir, "fh6-radio", "config.toml");
  if (!(await isFile(configDst))) {
    await backupAndCopy(path.join(dist, "fh6-radio", "config.toml"), configDst);
  }
  await patchLumenRadioConfig(configDst);

  let copiedFiles = 1;
  let brandedFiles = 0;
  const mediaDst = path.join(gameDir, "media");
  if (!req.skipMedia) {
    if (!req.mediaSource) throw new Error("Choose a radio media ZIP or folder");
    const mediaRoot = await mediaRootFromSource(req.mediaSource);
    copiedFiles += await copyTreeWithBackup(mediaRoot, mediaDst);
  }
  brandedFiles = await brandInstalledMedia(mediaDst);

  await saveConfigPatch({ fh6GameDir: gameDir, fh6RadioEnabled: true });
  return { ok: true, status: await fh6Status(), copiedFiles, brandedFiles };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

function proxyApi(req: IncomingMessage, res: ServerResponse): void {
  if (!backendUrl) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Backend not configured");
    return;
  }
  let target: URL;
  try {
    target = new URL(req.url ?? "/", backendUrl);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Invalid backend URL: ${(e as Error).message}`);
    return;
  }
  const lib = target.protocol === "https:" ? https : http;
  const headers = { ...req.headers };
  headers.host = target.host;
  delete headers["content-length"];
  const upstream = lib.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    },
  );
  upstream.on("error", (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end(`Bad gateway: ${e.message}`);
  });
  req.pipe(upstream);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let filePath: string;
  try {
    const u = new URL(req.url ?? "/", "http://x");
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
    const normalized = path.posix.normalize("/" + rel).replace(/^\/+/, "");
    filePath = path.join(DIST_DIR, normalized);
    if (!filePath.startsWith(DIST_DIR)) throw new Error("path escape");
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeFor(filePath),
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    try {
      const data = await fsp.readFile(path.join(DIST_DIR, "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Error: ${(e as Error).message}`);
    }
  }
}

function startProxyServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url && req.url.startsWith("/api/")) {
        proxyApi(req, res);
      } else {
        void serveStatic(req, res);
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      proxyPort = addr && typeof addr === "object" ? addr.port : 0;
      proxyServer = server;
      resolve(proxyPort);
    });
  });
}

async function openMain(): Promise<void> {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: NORMAL_MIN_SIZE.width,
    minHeight: NORMAL_MIN_SIZE.height,
    backgroundColor: "#00000000",
    frame: false,
    transparent: true,
    title: "Lumen — Music Library",
    autoHideMenuBar: true,
    alwaysOnTop,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: MAIN_PRELOAD,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    isMiniPlayer = false;
    normalBounds = null;
  });
  await mainWindow.loadURL(`http://127.0.0.1:${proxyPort}/`);
}

function openSetup(): void {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 520,
    height: 540,
    parent: mainWindow ?? undefined,
    modal: !!mainWindow,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: "Server configuration",
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      preload: SETUP_PRELOAD,
    },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.on("closed", () => {
    setupWindow = null;
  });
  void setupWindow.loadFile(SETUP_FILE);
}

ipcMain.handle("config:get", async () => {
  const cfg = await loadConfig();
  return {
    backendUrl: cfg.backendUrl ?? "",
    // `discordEnabled` defaults to true so existing installs keep the
    // integration on without a migration step.
    discordEnabled: cfg.discordEnabled ?? true,
    alwaysOnTop: cfg.alwaysOnTop ?? false,
    fh6RadioEnabled: cfg.fh6RadioEnabled === true,
    fh6GameDir: cfg.fh6GameDir ?? "",
    fh6BridgePort: cfg.fh6BridgePort ?? DEFAULT_FH6_BRIDGE_PORT,
  };
});

ipcMain.handle("config:save", async (_e, patch: SavePatch) => {
  const raw = typeof patch?.backendUrl === "string" ? patch.backendUrl.trim() : "";
  if (!raw) return { ok: false, error: "Server URL is required" };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return { ok: false, error: `Invalid URL: ${(e as Error).message}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "URL must start with http:// or https://" };
  }
  const normalized = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  const prev = backendUrl;
  const writePatch: SavePatch = { backendUrl: normalized };
  if (typeof patch?.discordEnabled === "boolean") {
    writePatch.discordEnabled = patch.discordEnabled;
    const wasEnabled = discordEnabled;
    discordEnabled = patch.discordEnabled;
    if (wasEnabled && !discordEnabled) {
      // User just turned the integration off — drop the live connection so
      // the Discord card disappears right away.
      void teardownDiscord();
    }
  }
  if (typeof patch?.alwaysOnTop === "boolean") {
    writePatch.alwaysOnTop = patch.alwaysOnTop;
    alwaysOnTop = patch.alwaysOnTop;
    mainWindow?.setAlwaysOnTop(alwaysOnTop);
  }
  if (typeof patch?.fh6RadioEnabled === "boolean") {
    writePatch.fh6RadioEnabled = patch.fh6RadioEnabled;
  }
  if (typeof patch?.fh6GameDir === "string") {
    writePatch.fh6GameDir = normalizeGameDir(patch.fh6GameDir);
  }
  if (typeof patch?.fh6BridgePort === "number") {
    writePatch.fh6BridgePort = Math.max(1, Math.min(65535, Math.floor(patch.fh6BridgePort)));
  }
  await saveConfigPatch(writePatch);
  backendUrl = normalized;
  return { ok: true, changed: prev !== "" && prev !== normalized };
});

ipcMain.handle("setup:done", async (_e, opts: SetupDoneOpts | undefined) => {
  const clear = !!opts?.clearSession;
  const hadMain = !!mainWindow;
  if (setupWindow) setupWindow.close();
  if (clear) {
    try {
      await session.defaultSession.clearStorageData({ storages: ["cookies"] });
    } catch {
      // Non-fatal: stale cookies will simply be rejected by the new backend.
    }
  }
  if (!hadMain) await openMain();
  else mainWindow?.webContents.reload();
  return { ok: true };
});

ipcMain.handle("setup:cancel", async () => {
  if (setupWindow) setupWindow.close();
  if (!mainWindow && !backendUrl) app.quit();
  return { ok: true };
});

ipcMain.handle("settings:open", () => {
  openSetup();
  return { ok: true };
});

ipcMain.handle("window:mini-player:set", (_e, enabled: boolean) => {
  if (!mainWindow) return { ok: false, miniPlayer: isMiniPlayer };
  setMiniPlayerMode(enabled);
  return { ok: true, miniPlayer: isMiniPlayer };
});

ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
  return { ok: true };
});

ipcMain.handle("window:maximize-toggle", () => {
  if (!mainWindow || isMiniPlayer) return { ok: false, maximized: false };
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { ok: true, maximized: mainWindow.isMaximized() };
});

ipcMain.handle("window:close", () => {
  mainWindow?.close();
  return { ok: true };
});

ipcMain.handle("fh6:status", async () => fh6Status());

ipcMain.handle("fh6:choose-game-dir", async () => {
  const options: OpenDialogOptions = {
    title: "Choose Forza Horizon 6 install folder",
    properties: ["openDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  const gameDir = normalizeGameDir(result.filePaths[0]);
  await saveConfigPatch({ fh6GameDir: gameDir });
  return { ok: true, gameDir, status: await fh6Status() };
});

ipcMain.handle("fh6:choose-media-source", async () => {
  const options: OpenDialogOptions = {
    title: "Choose radio media ZIP or folder",
    properties: ["openFile", "openDirectory"],
    filters: [
      { name: "Radio media", extensions: ["zip"] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  return { ok: true, path: normalizeGameDir(result.filePaths[0]) };
});

ipcMain.handle("fh6:install", async (_e, req: FH6InstallRequest) => {
  try {
    return await installFH6Radio(req ?? {});
  } catch (e) {
    return { ok: false, error: (e as Error).message, status: await fh6Status() };
  }
});

ipcMain.handle("fh6:sync-session", async () => {
  try {
    const cfg = await loadConfig();
    if (cfg.fh6RadioEnabled !== true) {
      return { ok: false, error: "Lumen Radio is disabled in settings" };
    }
    if (!backendUrl) return { ok: false, error: "Backend URL is not configured" };
    if (!proxyPort) return { ok: false, error: "Local app proxy is not ready" };

    const cookieHeader = await appCookieHeader();
    if (!cookieHeader) return { ok: false, error: "Log in to Lumen first" };

    const bridgeUrl = fh6BridgeUrl(cfg.fh6BridgePort ?? DEFAULT_FH6_BRIDGE_PORT);
    return await postJson(`${bridgeUrl}/api/lumen/session`, {
      server_url: backendUrl,
      session_cookie: cookieHeader,
      username: "",
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

async function appCookieHeader(): Promise<string> {
  const cookies = await session.defaultSession.cookies.get({
    url: `http://127.0.0.1:${proxyPort}`,
  });
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function postJson(urlString: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const target = new URL(urlString);
    const data = JSON.stringify(body);
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 4000,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300) {
            resolve({ ok: true });
            return;
          }
          try {
            const parsed = JSON.parse(raw) as { error?: string };
            resolve({ ok: false, error: parsed.error ?? raw });
          } catch {
            resolve({ ok: false, error: raw || `HTTP ${res.statusCode}` });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("FH6 bridge did not respond"));
    });
    req.on("error", (e) => {
      resolve({ ok: false, error: e.message });
    });
    req.end(data);
  });
}

function setMiniPlayerMode(enabled: boolean): void {
  if (!mainWindow || enabled === isMiniPlayer) return;

  if (enabled) {
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      normalBounds = mainWindow.getBounds();
    }
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    mainWindow.setMinimumSize(MINI_PLAYER_SIZE.width, MINI_PLAYER_SIZE.height);
    mainWindow.setMaximumSize(MINI_PLAYER_SIZE.width, MINI_PLAYER_SIZE.height);
    mainWindow.setResizable(false);
    mainWindow.setMaximizable(false);
    mainWindow.setBounds(
      boundsAroundCenter(mainWindow.getBounds(), MINI_PLAYER_SIZE),
      true,
    );
  } else {
    mainWindow.setResizable(true);
    mainWindow.setMaximizable(true);
    mainWindow.setMaximumSize(10000, 10000);
    mainWindow.setMinimumSize(NORMAL_MIN_SIZE.width, NORMAL_MIN_SIZE.height);
    if (normalBounds) {
      mainWindow.setBounds(normalBounds, true);
      normalBounds = null;
    } else {
      mainWindow.setSize(1280, 820, true);
    }
  }

  isMiniPlayer = enabled;
}

function boundsAroundCenter(
  bounds: Rectangle,
  size: { width: number; height: number },
): Rectangle {
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const x = Math.round(
    Math.max(area.x, Math.min(area.x + area.width - size.width, centerX - size.width / 2)),
  );
  const y = Math.round(
    Math.max(area.y, Math.min(area.y + area.height - size.height, centerY - size.height / 2)),
  );
  return { x, y, width: size.width, height: size.height };
}

// ────────────────────────────────────────────────────────────────────────
// Discord Rich Presence
//
// Loaded lazily so a missing `discord-rpc` dependency doesn't prevent the
// app from booting. The package is optional — if `discordClientId` is
// blank or the local Discord client isn't running, presence silently stays
// off. Activity type 2 ("Listening") is what makes Discord render
// "Listening to Lumen" above the card (instead of "Playing").
// ────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordClient = any;

// No application ID is shipped in code — create your own at
// https://discord.com/developers/applications and put it in `.env` (see
// .env.example). The `electron:compile` build step bakes it into
// buildenv.json next to this file; the user's config.json `discordClientId`
// still overrides it. While it's blank, Rich Presence silently stays off.
const DEFAULT_DISCORD_CLIENT_ID = readBakedDiscordClientId();

function readBakedDiscordClientId(): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "buildenv.json"), "utf8");
    const parsed = JSON.parse(raw) as { discordClientId?: string };
    return (parsed.discordClientId ?? "").trim();
  } catch {
    // buildenv.json missing (build step skipped) — presence stays off.
    return "";
  }
}

let discordClient: DiscordClient | null = null;
let discordConnecting = false;
let discordClientId = DEFAULT_DISCORD_CLIENT_ID;
let discordEnabled = true;
let lastActivity: DiscordActivityPayload | null = null;
let lastStartMs = 0;

async function ensureDiscord(): Promise<DiscordClient | null> {
  if (!discordEnabled) return null;
  if (!discordClientId) return null;
  if (discordClient) return discordClient;
  if (discordConnecting) return null;
  discordConnecting = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RPC = require("discord-rpc");
    const client = new RPC.Client({ transport: "ipc" });
    client.on("ready", () => {
      console.log("[discord] connected as client", discordClientId);
    });
    client.on("disconnected", () => {
      console.log("[discord] disconnected");
      discordClient = null;
    });
    await client.login({ clientId: discordClientId });
    discordClient = client;
    return client;
  } catch (e) {
    const msg = (e as Error).message || String(e);
    // Very common on first run: user hasn't run `npm install` yet.
    if (msg.includes("Cannot find module") && msg.includes("discord-rpc")) {
      console.warn(
        "[discord] `discord-rpc` package not installed — run `npm install`",
      );
    } else {
      console.warn("[discord] connect failed:", msg);
    }
    return null;
  } finally {
    discordConnecting = false;
  }
}

function clampForDiscord(s: string | undefined, max = 128): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (!t) return undefined;
  // Discord's Rich Presence text fields need ≥2 characters.
  return t.length < 2 ? `${t} ` : t.slice(0, max);
}

/**
 * Turn a renderer-side cover URL into something Discord can actually fetch.
 * The renderer sees `http://127.0.0.1:<proxyPort>/api/…`; swap the host for
 * the user's configured `backendUrl` so Discord's media proxy can reach it.
 * If the backend isn't publicly reachable over HTTPS, use the static asset
 * key instead — Discord won't fetch HTTP or LAN URLs.
 */
function discordCoverImage(coverUrl: string | undefined): string {
  const fallback = "lumen";
  if (!coverUrl) return fallback;
  if (!backendUrl) {
    return /^https:/i.test(coverUrl) ? coverUrl : fallback;
  }
  try {
    const src = new URL(coverUrl);
    const isLoopback =
      src.hostname === "127.0.0.1" ||
      src.hostname === "localhost" ||
      src.hostname === "[::1]";
    const rewritten = isLoopback
      ? new URL(src.pathname + src.search, backendUrl).toString()
      : src.toString();
    // Discord silently ignores non-HTTPS large_image URLs; keep the asset
    // key fallback in that case.
    return /^https:/i.test(rewritten) ? rewritten : fallback;
  } catch {
    return fallback;
  }
}

async function pushDiscordActivity(payload: DiscordActivityPayload): Promise<{
  ok: boolean;
  error?: string;
}> {
  const client = await ensureDiscord();
  if (!client) return { ok: false, error: "discord client unavailable" };
  try {
    // Timestamps only make sense while playing. Discord renders the bar from
    // `start` to `end`; pass both so the correct position shows up.
    const now = Date.now();
    const elapsedMs = Math.max(0, Math.floor((payload.elapsedSec ?? 0) * 1000));
    const startTs = now - elapsedMs;
    // Preserve the start across updates for the *same track* so the progress
    // bar doesn't jitter on each throttled re-push (~every 15 s). Identity is
    // by trackId — title/artist/album match falsely across re-uploads, and
    // also across the brief stale-metadata window right after a track switch
    // where the renderer would otherwise lock in the outgoing track's start.
    const sameTrack =
      lastActivity &&
      payload.trackId !== undefined &&
      lastActivity.trackId === payload.trackId &&
      lastActivity.isPlaying;
    // During continuous playback `startTs` stays roughly constant across
    // re-pushes (now and elapsed advance together). A large drift means the
    // renderer reported a fresh elapsed — repeat-one looping back to 0 or a
    // user seek. Don't preserve the old start in that case, or Discord's
    // progress bar stays frozen at the end of the previous play.
    const seekedOrLooped =
      sameTrack && Math.abs(startTs - lastStartMs) > 2500;
    const start =
      sameTrack && payload.isPlaying && lastStartMs > 0 && !seekedOrLooped
        ? lastStartMs
        : startTs;
    const end =
      payload.isPlaying && payload.durationSec && payload.durationSec > 0
        ? start + Math.floor(payload.durationSec * 1000)
        : undefined;

    // Use the raw request directly — `client.setActivity()` in discord-rpc 4.x
    // drops the `type` field, which would leave us stuck on "Playing".
    // Sending via `request("SET_ACTIVITY", …)` preserves `type: 2` (LISTENING)
    // so Discord renders "Listening to Lumen" at the top of the card.
    //
    // Cover URL: the renderer only sees the local proxy host, but Discord
    // can't fetch that. Swap the host for the real `backendUrl` so Discord's
    // CDN reaches the publicly-deployed server. Non-public backends (plain
    // http, LAN IPs) fall back to the uploaded asset key.
    const largeImage = discordCoverImage(payload.coverUrl);
    await client.request("SET_ACTIVITY", {
      pid: process.pid,
      activity: {
        type: 2,
        details: clampForDiscord(payload.title) ?? "Music",
        state: clampForDiscord(payload.artist ?? payload.album),
        timestamps: payload.isPlaying
          ? {
              start: Math.floor(start / 1000),
              ...(end ? { end: Math.floor(end / 1000) } : {}),
            }
          : undefined,
        assets: {
          large_image: largeImage,
          large_text: clampForDiscord(payload.album) ?? undefined,
          small_image: payload.isPlaying ? "play" : "pause",
          small_text: payload.isPlaying ? "Playing" : "Paused",
        },
        instance: false,
      },
    });
    lastActivity = payload;
    lastStartMs = start;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function clearDiscordActivity(): Promise<void> {
  const client = discordClient;
  if (!client) return;
  try {
    await client.clearActivity();
  } catch {
    // no-op
  }
  lastActivity = null;
  lastStartMs = 0;
}

/** Fully drop the Discord IPC connection. Used when the user disables the
 *  integration so the "Listening to Lumen" card goes away immediately. */
async function teardownDiscord(): Promise<void> {
  const client = discordClient;
  discordClient = null;
  lastActivity = null;
  lastStartMs = 0;
  if (!client) return;
  try {
    await client.clearActivity();
  } catch {
    // no-op
  }
  try {
    await client.destroy();
  } catch {
    // no-op
  }
}

ipcMain.handle("discord:activity", async (_e, payload: DiscordActivityPayload) => {
  if (!payload || typeof payload.title !== "string") {
    return { ok: false, error: "invalid payload" };
  }
  return pushDiscordActivity(payload);
});

ipcMain.handle("discord:clear", async () => {
  await clearDiscordActivity();
  return { ok: true };
});

ipcMain.handle(
  "titlebar:theme",
  (_e, opts: { color?: string; symbolColor?: string } | undefined) => {
    if (!opts) return { ok: false };
    if (opts.color) titleBarColor = opts.color;
    if (opts.symbolColor) symbolColor = opts.symbolColor;
    if (!mainWindow) return { ok: true };
    if (process.platform !== "win32" && process.platform !== "linux") {
      return { ok: true };
    }
    try {
      mainWindow.setBackgroundColor("#00000000");
    } catch {
      // Platform may not support overlay updates.
    }
    return { ok: true };
  },
);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (setupWindow) {
      setupWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // Grant `media` so `navigator.mediaDevices.enumerateDevices()` returns
    // labelled `audiooutput` entries. Chromium hides labels until microphone
    // permission is granted; without this the device picker shows blanks.
    session.defaultSession.setPermissionRequestHandler(
      (_wc, permission, callback) => {
        callback(permission === "media");
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (_wc, permission) => permission === "media",
    );
    const cfg = await loadConfig();
    backendUrl = cfg.backendUrl ?? "";
    const configured = (cfg.discordClientId ?? "").trim();
    if (configured) discordClientId = configured;
    discordEnabled = cfg.discordEnabled ?? true;
    alwaysOnTop = cfg.alwaysOnTop ?? false;
    await startProxyServer();
    if (!backendUrl) openSetup();
    else await openMain();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!backendUrl) openSetup();
      else void openMain();
    }
  });

  app.on("before-quit", () => {
    proxyServer?.close();
    if (discordClient) {
      try {
        void discordClient.destroy();
      } catch {
        // no-op
      }
      discordClient = null;
    }
  });
}
