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
];

for (const scene of SCENES) {
  test(scene.name, async ({ page }, info) => {
    await stubElectron(page);
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
    await settle(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}${scene.name}-${info.project.name}.png`, omitBackground: true });
  });
}
