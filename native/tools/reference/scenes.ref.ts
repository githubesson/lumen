// One screenshot per scene of the Electron frontend. The Rune app renders the
// same scenes headlessly (`lumen --snap … --scene <name>`), against the same
// fixtures served by tools/mock-server.ts, so the two can be diffed.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, type Page } from "playwright/test";
import { go, ready, settle, signedIn, signedOut } from "../../../frontend/tests/ui/helpers";
import { tracks } from "../../../frontend/tests/ui/fixtures";

const OUT = fileURLToPath(new URL("../../out/ref/", import.meta.url));
mkdirSync(OUT, { recursive: true });

/** The desktop bridge as the Windows build's preload exposes it. */
async function stubElectron(page: Page) {
  await page.addInitScript(() => {
    const base: Record<string, unknown> = {
      isElectron: true,
      platform: "win32",
      getConfig: async () => ({
        backendUrl: location.origin,
        discordEnabled: false,
        alwaysOnTop: false,
        nowPlayingApiEnabled: false,
      }),
      getSignOutIntent: async () => false,
      setSignOutIntent: async () => {},
      getTweaks: async () => ({ tweaks: {}, audioSinkId: "" }),
      getMiniPlayerPanelAnchor: async () => "top",
      getUpdateStatus: undefined,
      onUpdateStatus: undefined,
      setDiscordActivity: undefined,
      clearDiscordActivity: undefined,
    };
    (window as unknown as { electron: unknown }).electron = new Proxy(base, {
      get: (t, k) =>
        typeof k === "string" && !(k in t) && k !== "then" ? async () => ({ ok: false }) : t[k as string],
      has: () => true,
    });
    document.addEventListener("DOMContentLoaded", () =>
      document.documentElement.setAttribute("data-electron", "true"),
    );
  });
}

type Scene = {
  name: string;
  path?: string;
  signedOut?: boolean;
  /** Waits for the scene's own content before the shot. */
  wait?: (page: Page) => Promise<void>;
  act?: (page: Page) => Promise<void>;
  /** Window size, when not the default 1280×820. */
  size?: { width: number; height: number };
  /** Skip `settle` (it waits on every finite animation) and just wait. */
  noSettle?: boolean;
  /** Runs before the app loads (init scripts, exposed functions). */
  setup?: (page: Page) => Promise<void>;
};

const SCENES: Scene[] = [
  { name: "home", path: "/", wait: (p) => ready(p, p.locator(".board, .home")) },
  { name: "library", path: "/library", wait: (p) => ready(p, p.locator("tbody tr")) },
  { name: "albums", path: "/library?view=albums", wait: (p) => ready(p, p.locator(".card")) },
  { name: "artists", path: "/library?view=artists", wait: (p) => ready(p, p.locator(".card")) },
  { name: "favorites", path: "/favorites", wait: (p) => ready(p, p.locator("tbody tr")) },
  { name: "recent", path: "/recent", wait: (p) => ready(p, p.locator("tbody tr")) },
  { name: "playlists", path: "/playlists", wait: (p) => ready(p, p.locator(".card, .playlist-card")) },
  { name: "replay", path: "/replay", wait: (p) => ready(p, p.locator(".replay, main")) },
  { name: "admin", path: "/admin", wait: (p) => ready(p, p.locator(".admin, main")) },
  { name: "login", signedOut: true, path: "/login", wait: (p) => ready(p, p.locator("form")) },
  { name: "library-medium", path: "/library", size: { width: 900, height: 700 }, wait: (p) => ready(p, p.locator("tbody tr")) },
  { name: "library-narrow", path: "/library", size: { width: 700, height: 600 }, wait: (p) => ready(p, p.locator("tbody tr")) },
  {
    name: "drawer-narrow",
    path: "/library",
    size: { width: 700, height: 600 },
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await p.getByRole("button", { name: "Open navigation" }).click();
      await p.waitForTimeout(400);
    },
    noSettle: true,
  },
];

// ---- The player's popovers, lyrics and mini player ----

/** The track the error scenes fail: its stream answers 410. */
const FAILING = "t-al-weather-4";
/** When the error scenes fail, so the details' Time line is fixed. */
const FAILED_AT = "2026-11-06T12:00:00.000Z";

/** The bar's buttons, by name. */
const barButton = (p: Page, name: string) => p.locator(".player-bar").getByRole("button", { name, exact: true });

/** The mock's silent WAV for `seconds`, served with byte ranges so the
 *  player can seek in it (the mock's own stream isn't seekable). */
function seekableStream(seconds: number) {
  const rate = 8000;
  const samples = Math.max(1, Math.round(seconds * rate));
  const wav = Buffer.alloc(44 + samples, 0x80);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + samples, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples, 40);
  return wav;
}

/** Seek the paused track to 0:15 with the player's → key (5 s a press). */
async function seekTo15(p: Page) {
  const [first, second] = tracks;
  const wav = seekableStream(first.duration_ms / 1000);
  await p.route(`**/api/tracks/${first.id}/stream`, (route) => {
    const m = route.request().headers()["range"]?.match(/bytes=(\d+)-(\d*)/);
    const headers = { "Content-Type": "audio/wav", "Accept-Ranges": "bytes" };
    if (!m) return route.fulfill({ status: 200, body: wav, headers });
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : wav.length - 1;
    return route.fulfill({
      status: 206,
      body: wav.subarray(start, end + 1),
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${wav.length}` },
    });
  });
  // Load the first track again, from the seekable stream: play the second
  // row, then the first (the queue stays the library list).
  const bar = p.locator(".player-bar");
  const titleOf = (t: (typeof tracks)[number]) => p.locator(".track-title").and(p.getByTitle(t.title, { exact: true })).first();
  await titleOf(second).dispatchEvent("click");
  await bar.locator(".np-title").filter({ hasText: second.title }).waitFor();
  await titleOf(first).dispatchEvent("click");
  await bar.locator(".np-title").filter({ hasText: first.title }).waitFor();
  await p.waitForFunction(() => document.querySelector(".player-bar")?.getAttribute("data-playing") === "true" || document.querySelectorAll(".player-bar .progress-time")[1]?.textContent !== "0:00");
  if ((await bar.getAttribute("data-playing")) === "true") await barButton(p, "Pause").dispatchEvent("click");
  await p.waitForFunction(() => document.querySelector(".player-bar")?.getAttribute("data-playing") === "false");
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const time = () => p.locator(".player-bar .progress-time").first().textContent();
  // Back to the start (it may have played a moment), then three steps.
  for (let i = 0; i < 4; i++) await p.keyboard.press("ArrowLeft");
  for (let i = 0; i < 20 && (await time()) !== "0:00"; i++) await p.waitForTimeout(100);
  for (let i = 0; i < 3; i++) {
    await p.keyboard.press("ArrowRight");
    await p.waitForTimeout(300);
  }
  for (let i = 0; i < 20 && (await time()) !== "0:15"; i++) await p.waitForTimeout(150);
  if ((await time()) !== "0:15") throw new Error(`seek landed on ${await time()}`);
}

/** Play the failing track and wait for its error line. */
async function failTrack(p: Page) {
  await p.clock.setFixedTime(new Date(FAILED_AT));
  await p.route(`**/api/tracks/${FAILING}/stream`, (route) =>
    route.fulfill({ status: 410, contentType: "text/plain", body: "file missing on disk" }),
  );
  const failing = tracks.find((t) => t.id === FAILING)!;
  await p.locator(".track-title").and(p.getByTitle(failing.title, { exact: true })).first().dispatchEvent("click");
  await barButton(p, "Couldn't play this track.").waitFor();
}

/** The desktop bridge's mini player calls resize the viewport, as the window does. */
async function miniWindow(page: Page) {
  await page.exposeFunction("__lumenResize", async (w: number, h: number) => {
    await page.setViewportSize({ width: w, height: h });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __lumenResize: (w: number, h: number) => Promise<void>; electron: Record<string, unknown> };
    w.electron.setMiniPlayerMode = async (on: boolean) => {
      await w.__lumenResize(on ? 780 : 1280, on ? 184 : 820);
      return { ok: true, miniPlayer: on };
    };
    w.electron.getMiniPlayerPanelAnchor = async () => "top";
    w.electron.setMiniPlayerPanel = async (open: boolean) => {
      await w.__lumenResize(780, open ? 344 : 184);
      return { ok: true, open, anchor: "top" };
    };
  });
}

async function enterMini(p: Page) {
  await barButton(p, "Mini player").click();
  await p.waitForFunction(() => document.documentElement.hasAttribute("data-mini-player") && innerHeight === 184);
}

async function openMiniPanel(p: Page, button: string) {
  await barButton(p, button).click();
  await p.waitForFunction(() => innerHeight === 344);
  await p.locator(".mini-panel-content").waitFor();
  await p.waitForTimeout(800);
}

const lyricsText = (p: Page) => ready(p, p.getByText("the kettle's still warm", { exact: false }));

SCENES.push(
  {
    name: "queue-open",
    path: "/library",
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await barButton(p, "Queue").click();
      await p.getByRole("dialog", { name: "Play queue" }).waitFor();
    },
  },
  {
    name: "devices-open",
    path: "/library",
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await p.locator(".player-bar .device-picker-btn").click();
      await p.getByRole("dialog", { name: "Playback device" }).getByText("Live").waitFor();
    },
  },
  {
    name: "lyrics-open",
    path: "/library",
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await seekTo15(p);
      await barButton(p, "Toggle lyrics panel").click();
      await lyricsText(p);
      await p.waitForTimeout(500);
    },
  },
  {
    name: "lyrics-narrow",
    path: "/library",
    size: { width: 700, height: 600 },
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await seekTo15(p);
      await barButton(p, "Toggle lyrics panel").click();
      await lyricsText(p);
      await p.waitForTimeout(500);
    },
  },
  {
    name: "error-popover",
    path: "/library",
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await failTrack(p);
      await barButton(p, "Couldn't play this track.").click();
      await p.getByRole("dialog", { name: "Playback error" }).getByText("HTTP 410", { exact: false }).waitFor();
    },
  },
  {
    name: "mini",
    path: "/library",
    setup: miniWindow,
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: enterMini,
  },
  {
    name: "mini-queue",
    path: "/library",
    setup: miniWindow,
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await enterMini(p);
      await openMiniPanel(p, "Queue");
    },
  },
  {
    name: "mini-lyrics",
    path: "/library",
    setup: miniWindow,
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await seekTo15(p);
      await enterMini(p);
      await openMiniPanel(p, "Toggle lyrics panel");
      await lyricsText(p);
    },
  },
  {
    name: "mini-devices",
    path: "/library",
    setup: miniWindow,
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await enterMini(p);
      await openMiniPanel(p, "Choose playback device");
      await p.locator(".mini-panel-head").getByText("Live").waitFor();
    },
  },
  {
    name: "mini-error",
    path: "/library",
    setup: miniWindow,
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await failTrack(p);
      await enterMini(p);
      await barButton(p, "Couldn't play this track.").click();
      await p.waitForFunction(() => innerHeight === 344);
      await p.locator(".mini-panel-error").getByText("HTTP 410", { exact: false }).waitFor();
      await p.waitForTimeout(800);
    },
  },
);

for (const scene of SCENES) {
  test(scene.name, async ({ page }, info) => {
    await stubElectron(page);
    await scene.setup?.(page);
    if (scene.size) await page.setViewportSize(scene.size);
    if (scene.signedOut) {
      await signedOut(page);
      await page.goto(scene.path ?? "/login");
    } else {
      await signedIn(page);
      if (scene.path) await go(page, scene.path);
    }
    await scene.wait?.(page);
    await scene.act?.(page);
    await page.mouse.move(-10, -10);
    if (scene.noSettle) await page.waitForTimeout(800);
    else await settle(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}${scene.name}-${info.project.name}.png`, omitBackground: true });
  });
}
