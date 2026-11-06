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
};

/** The playlist page's own track rows (not the library's, still up as it opens). */
const rows = (p: Page) => ready(p, p.locator(".view:has(.playlist-toolbar) tbody tr"));
/** Picks a tab without moving the mouse (no hover left behind). */
const tab = (p: Page, name: string | RegExp) => p.getByRole("tab", { name }).first().dispatchEvent("click");

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
  // Playlists: one owned private, one owned collaborative, one shared with
  // the user as an editor (fixtures.ts), each on its tabs.
  { name: "playlist-owned", path: "/playlists/pl-night-drives", wait: rows },
  { name: "playlist-collab", path: "/playlists/pl-sunday-coffee", wait: rows },
  { name: "playlist-shared", path: "/playlists/pl-road-trip", wait: rows },
  {
    name: "playlist-collaborators",
    path: "/playlists/pl-sunday-coffee",
    wait: rows,
    act: async (p) => {
      await tab(p, /^Collaborators/);
      await ready(p, p.getByText("theo", { exact: true }));
    },
  },
  {
    name: "playlist-shared-collaborators",
    path: "/playlists/pl-road-trip",
    wait: rows,
    act: async (p) => {
      await tab(p, /^Collaborators/);
      await ready(p, p.getByText("priya", { exact: true }));
    },
  },
  {
    name: "playlist-settings",
    path: "/playlists/pl-sunday-coffee",
    wait: rows,
    act: async (p) => {
      await tab(p, "Settings");
      await ready(p, p.getByRole("textbox", { name: "Name" }));
    },
  },
  {
    name: "playlist-shared-settings",
    path: "/playlists/pl-road-trip",
    wait: rows,
    act: async (p) => {
      await tab(p, "Settings");
      await ready(p, p.getByText("Save TIDAL tracks to the library"));
    },
  },
  {
    name: "playlist-add",
    path: "/playlists/pl-night-drives",
    wait: rows,
    act: async (p) => {
      await p.getByRole("button", { name: "Add tracks" }).dispatchEvent("click");
      await ready(p, p.locator("[role=dialog] li"));
      // The search field is focused when the dialog opens; drop the caret
      // and focus ring so both apps show the field at rest.
      await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
  },
  {
    // A row picked up and held over the gap above the fifth row.
    name: "playlist-drag",
    path: "/playlists/pl-night-drives",
    wait: rows,
    act: async (p) => {
      const all = p.locator(".view:has(.playlist-toolbar) tbody tr");
      const data = await p.evaluateHandle(() => new DataTransfer());
      await all.nth(1).dispatchEvent("dragstart", { dataTransfer: data });
      const box = (await all.nth(4).boundingBox())!;
      await all.nth(4).dispatchEvent("dragover", { dataTransfer: data, clientX: box.x + 40, clientY: box.y + 4 });
    },
  },
  { name: "playlist-new", path: "/playlists/new", wait: (p) => ready(p, p.getByRole("heading", { name: "New playlist" })) },
  { name: "invites", path: "/invites", wait: (p) => ready(p, p.getByText("Wedding Reception", { exact: false })) },
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
