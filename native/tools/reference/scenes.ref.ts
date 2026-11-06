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
  /** Leave the pointer where `act` put it (hover states). */
  keepPointer?: boolean;
  /** Runs once signed in, before `path` opens (extra API routes). */
  before?: (page: Page) => Promise<void>;
};

/** Replay with its tiles loaded (the placeholder bento has the same headings). */
const replayLoaded = (p: Page) => ready(p, p.locator(".replay-bento:not(.is-loading), .replay .empty-state"));

/** Scrolls the routed content (`.content`) to `top`, clamped to its end. */
const scrollContent = (p: Page, top: number) =>
  p.locator(".content").evaluate((el, y) => {
    el.scrollTop = y;
  }, top);

/** A Replay answer with no plays (the server's shape for an empty window). */
const emptyReplay = {
  summary: { total_plays: 0, total_ms: 0, unique_tracks: 0, unique_artists: 0 },
  top_tracks: [], top_artists: [], top_albums: [], top_genres: [], activity: [], bucket: "day", available_years: [2025, 2026],
};

const SCENES: Scene[] = [
  { name: "home", path: "/", wait: (p) => ready(p, p.locator(".board, .home")) },
  { name: "library", path: "/library", wait: (p) => ready(p, p.locator("tbody tr")) },
  { name: "albums", path: "/library?view=albums", wait: (p) => ready(p, p.locator(".card")) },
  { name: "artists", path: "/library?view=artists", wait: (p) => ready(p, p.locator(".card")) },
  { name: "favorites", path: "/favorites", wait: (p) => ready(p, p.locator("tbody tr")) },
  { name: "recent", path: "/recent", wait: (p) => ready(p, p.locator("tbody tr")) },
  { name: "playlists", path: "/playlists", wait: (p) => ready(p, p.locator(".card, .playlist-card")) },
  { name: "replay", path: "/replay", wait: replayLoaded },
  { name: "replay-last30", path: "/replay?period=last-30", wait: replayLoaded },
  { name: "replay-month", path: "/replay?period=this-month", wait: replayLoaded },
  { name: "replay-2025", path: "/replay?period=year:2025", wait: replayLoaded },
  { name: "replay-all", path: "/replay?period=all", wait: replayLoaded },
  {
    name: "replay-empty",
    path: "/replay?period=last-30",
    before: (p) => p.route("**/api/stats/replay?**", (r) => r.fulfill({ json: emptyReplay })),
    wait: replayLoaded,
  },
  {
    name: "replay-loading",
    path: "/replay",
    // Never answers: the placeholder bento stays up.
    before: (p) => p.route("**/api/stats/replay?**", () => {}),
    wait: (p) => p.locator(".replay-bento.is-loading").waitFor(),
  },
  {
    name: "replay-all-tracks",
    path: "/replay",
    wait: replayLoaded,
    act: async (p) => {
      await p.getByRole("button", { name: /^Show all \d+$/ }).click();
      await p.getByRole("button", { name: "Show fewer" }).waitFor();
      // The click scrolled the button into view; settle on a fixed offset.
      await scrollContent(p, 380);
    },
  },
  {
    name: "replay-hover",
    path: "/replay",
    wait: replayLoaded,
    act: async (p) => {
      const box = await p.locator(".bento-row").nth(1).boundingBox();
      await p.mouse.move(box!.x + 120, box!.y + box!.height / 2);
    },
    keepPointer: true,
  },
  { name: "replay-medium", path: "/replay", size: { width: 900, height: 700 }, wait: replayLoaded },
  { name: "replay-narrow", path: "/replay", size: { width: 700, height: 600 }, wait: replayLoaded },
  // With the sidebar the panel is under 560 px: the bento's phone layout.
  { name: "replay-small", path: "/replay", size: { width: 820, height: 700 }, wait: replayLoaded },
  // Below the fold: the content scrolled 420 px (Rune: scripts/replay-scroll.json), and to its end.
  { name: "replay-mid", path: "/replay", wait: replayLoaded, act: (p) => scrollContent(p, 420) },
  { name: "replay-bottom", path: "/replay", wait: replayLoaded, act: (p) => scrollContent(p, 1e6) },
  { name: "replay-month-bottom", path: "/replay?period=this-month", wait: replayLoaded, act: (p) => scrollContent(p, 1e6) },
  {
    name: "replay-all-tracks-bottom",
    path: "/replay",
    wait: replayLoaded,
    act: async (p) => {
      await p.getByRole("button", { name: /^Show all \d+$/ }).click();
      await p.getByRole("button", { name: "Show fewer" }).waitFor();
      await scrollContent(p, 1e6);
    },
  },
  { name: "replay-medium-bottom", path: "/replay", size: { width: 900, height: 700 }, wait: replayLoaded, act: (p) => scrollContent(p, 1e6) },
  { name: "replay-narrow-mid", path: "/replay", size: { width: 700, height: 600 }, wait: replayLoaded, act: (p) => scrollContent(p, 420) },
  { name: "replay-narrow-bottom", path: "/replay", size: { width: 700, height: 600 }, wait: replayLoaded, act: (p) => scrollContent(p, 1e6) },
  { name: "replay-small-mid", path: "/replay", size: { width: 820, height: 700 }, wait: replayLoaded, act: (p) => scrollContent(p, 420) },
  { name: "replay-small-bottom", path: "/replay", size: { width: 820, height: 700 }, wait: replayLoaded, act: (p) => scrollContent(p, 1e6) },
  { name: "admin", path: "/admin", wait: (p) => ready(p, p.locator(".admin, main")) },
  // Shared components (TrackList, the track menu, tooltips) on the Favorites page.
  {
    name: "favorites-hover",
    path: "/favorites",
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      const box = await p.locator("tbody tr").nth(1).boundingBox();
      await p.mouse.move(box!.x + 300, box!.y + box!.height / 2);
    },
    keepPointer: true,
  },
  {
    name: "favorites-select",
    path: "/favorites",
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await p.getByRole("button", { name: "Select", exact: true }).click();
      await p.locator("tbody tr").nth(0).click();
      await p.locator("tbody tr").nth(2).click();
    },
  },
  {
    name: "favorites-menu",
    path: "/favorites",
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      const box = await p.locator("tbody tr").nth(1).boundingBox();
      await p.mouse.click(box!.x + 300, box!.y + box!.height / 2, { button: "right" });
      await p.locator(".ctx-menu .ctx-pl").first().waitFor();
    },
    keepPointer: true,
  },
  {
    name: "favorites-menu-many",
    path: "/favorites",
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await p.getByRole("button", { name: "Select", exact: true }).click();
      await p.locator("tbody tr").nth(0).click();
      await p.locator("tbody tr").nth(2).click();
      const box = await p.locator("tbody tr").nth(2).boundingBox();
      await p.mouse.click(box!.x + 300, box!.y + box!.height / 2, { button: "right" });
      await p.locator(".ctx-menu .ctx-pl").first().waitFor();
    },
    keepPointer: true,
  },
  {
    name: "tooltip",
    path: "/favorites",
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      const box = await p.getByRole("button", { name: "Settings" }).first().boundingBox();
      await p.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await p.locator(".tooltip:not([data-closed])").waitFor();
    },
    keepPointer: true,
  },
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
    if (scene.size) await page.setViewportSize(scene.size);
    if (scene.signedOut) {
      await signedOut(page);
      await page.goto(scene.path ?? "/login");
    } else {
      await signedIn(page);
      await scene.before?.(page);
      if (scene.path) await go(page, scene.path);
    }
    await scene.wait?.(page);
    await scene.act?.(page);
    if (!scene.keepPointer) await page.mouse.move(-10, -10);
    if (scene.noSettle) await page.waitForTimeout(800);
    else await settle(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}${scene.name}-${info.project.name}.png`, omitBackground: true });
  });
}
