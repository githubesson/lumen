// One screenshot per scene of the Electron frontend. The Rune app renders the
// same scenes headlessly (`lumen --snap … --scene <name>`), against the same
// fixtures served by tools/mock-server.ts, so the two can be diffed.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, type Page } from "playwright/test";
import { go, ready, settle, signedIn, signedOut } from "../../../frontend/tests/ui/helpers";

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
  /** `tweaks.homeBoard` to seed before sign-in (Home's saved arrangement). */
  homeBoard?: unknown;
};

/** Home with its default panels swapped about and one hidden: still the default layout. */
const SWAPPED_BOARD = {
  panels: [
    { id: "albums", kind: "albums", w: 4, h: 1 },
    { id: "repeat", kind: "repeat", w: 2, h: 2 },
    { id: "favorites", kind: "favorites", w: 2, h: 1 },
    { id: "recent", kind: "recent", w: 2, h: 1 },
    { id: "resume", kind: "resume", w: 4, h: 1 },
    { id: "playlists", kind: "playlists", w: 2, h: 1, hidden: true },
    { id: "artists", kind: "artists", w: 6, h: 1 },
  ],
};

/** Every kind of panel, in sizes the default board doesn't use (the UI lint's board). */
const CUSTOM_BOARD = {
  panels: [
    { id: "resume", kind: "resume", w: 4, h: 1 },
    { id: "stats", kind: "stats", w: 2, h: 1, period: "this-year" },
    { id: "repeat", kind: "repeat", w: 2, h: 2, title: "Heavy rotation" },
    { id: "activity", kind: "activity", w: 4, h: 1, period: "this-year" },
    { id: "genres", kind: "genres", w: 3, h: 1, period: "this-year" },
    { id: "added", kind: "added", w: 3, h: 1 },
    { id: "top-albums", kind: "top-albums", w: 6, h: 1, period: "all" },
    { id: "playlist", kind: "playlist", w: 3, h: 1, playlist: "pl-night-drives" },
    { id: "recent", kind: "recent", w: 3, h: 1 },
    { id: "artists", kind: "artists", w: 4, h: 1, period: "this-month" },
    { id: "repeat-2", kind: "repeat", w: 2, h: 1, period: "all" },
    { id: "favorites", kind: "favorites", w: 2, h: 1, hidden: true },
    { id: "albums", kind: "albums", w: 6, h: 1 },
    { id: "playlists", kind: "playlists", w: 6, h: 1, hidden: true },
    { id: "artists-2", kind: "artists", w: 2, h: 1, period: "all", hidden: true, title: "Everyone I kept coming back to all year long" },
  ],
};

const boardReady = (p: Page) => ready(p, p.locator(".board"));
/** Clicks without moving the mouse, so no hover is left behind. */
const press = (p: Page, name: string | RegExp) => p.getByRole("button", { name }).first().dispatchEvent("click");

const SCENES: Scene[] = [
  { name: "home", path: "/", wait: (p) => ready(p, p.locator(".board, .home")) },
  { name: "home-medium", path: "/", size: { width: 900, height: 700 }, wait: boardReady },
  { name: "home-narrow", path: "/", size: { width: 700, height: 600 }, wait: boardReady },
  { name: "home-customize", path: "/?customize", wait: boardReady },
  { name: "home-swapped", path: "/", homeBoard: SWAPPED_BOARD, wait: boardReady },
  { name: "home-custom", path: "/", homeBoard: CUSTOM_BOARD, size: { width: 1280, height: 1400 }, wait: boardReady },
  { name: "home-custom-customize", path: "/?customize", homeBoard: CUSTOM_BOARD, wait: boardReady },
  {
    name: "home-add",
    path: "/?customize",
    homeBoard: CUSTOM_BOARD,
    wait: boardReady,
    act: async (p) => {
      await press(p, "Add panel");
      await ready(p, p.getByRole("dialog", { name: "Add a panel" }));
    },
  },
  {
    name: "home-settings",
    path: "/?customize",
    homeBoard: CUSTOM_BOARD,
    wait: boardReady,
    act: async (p) => {
      await press(p, /^Edit\s*Heavy rotation \(Last 30 days\)$/);
      await ready(p, p.getByRole("dialog", { name: "Edit Heavy rotation (Last 30 days)" }));
    },
  },
  {
    name: "home-reset",
    path: "/?customize",
    homeBoard: CUSTOM_BOARD,
    wait: boardReady,
    act: async (p) => {
      await press(p, "Reset");
      await ready(p, p.getByRole("dialog", { name: "Reset Home?" }));
    },
  },
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

for (const scene of SCENES) {
  test(scene.name, async ({ page }, info) => {
    await stubElectron(page);
    if (scene.homeBoard) {
      // Saved tweaks skip the system's colour scheme, so they carry it.
      await page.addInitScript((homeBoard) => {
        const theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        const saved = JSON.parse(localStorage.getItem("lumen.tweaks") ?? "{}");
        localStorage.setItem("lumen.tweaks", JSON.stringify({ theme, ...saved, homeBoard }));
      }, scene.homeBoard);
    }
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
