// One screenshot per scene of the Electron frontend. The Rune app renders the
// same scenes headlessly (`lumen --snap … --scene <name>`), against the same
// fixtures served by tools/mock-server.ts, so the two can be diffed.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, type Page } from "playwright/test";
import { go, ready, settle, signedIn, signedOut } from "../../../frontend/tests/ui/helpers";

const OUT = fileURLToPath(new URL("../../out/ref/", import.meta.url));
mkdirSync(OUT, { recursive: true });

/** What a scene changes in the desktop bridge: config fields, and an update status. */
type Bridge = { config?: Record<string, unknown>; update?: Record<string, unknown> };

/** The desktop bridge as the Windows build's preload exposes it. */
async function stubElectron(page: Page, bridge: Bridge = {}) {
  await page.addInitScript((bridge: Bridge) => {
    const config = {
      backendUrl: location.origin,
      discordEnabled: false,
      alwaysOnTop: false,
      nowPlayingApiEnabled: false,
      ...bridge.config,
    };
    const update = bridge.update;
    const base: Record<string, unknown> = {
      isElectron: true,
      platform: "win32",
      getConfig: async () => config,
      updateConfig: async () => ({ ok: true, config, changed: false }),
      getSignOutIntent: async () => false,
      setSignOutIntent: async () => {},
      getTweaks: async () => ({ tweaks: {}, audioSinkId: "" }),
      getMiniPlayerPanelAnchor: async () => "top",
      getUpdateStatus: update ? async () => update : undefined,
      onUpdateStatus: update ? () => () => {} : undefined,
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
  }, bridge);
}

type Scene = {
  name: string;
  path?: string;
  signedOut?: boolean;
  /** Waits for the scene's own content before the shot. */
  wait?: (page: Page) => Promise<void>;
  act?: (page: Page) => Promise<void>;
  bridge?: Bridge;
};

/** The desktop config the desktop-settings lint run serves. */
const desktopConfig = {
  backendUrl: "https://music.example.com",
  discordEnabled: true,
  alwaysOnTop: false,
  discordCard: {
    details: "{title}",
    state: "{artist}",
    largeText: "{album}",
    statusName: "app",
    cover: true,
    playState: true,
    showPaused: true,
  },
  nowPlayingApiEnabled: true,
  nowPlayingApiUrl: "http://127.0.0.1:48638",
  nowPlayingApiToken: "first-token-0123456789",
  nowPlayingApiError: "",
};

/** An updater that found a new version. */
const updateAvailable = {
  state: "available",
  branch: "main",
  repoUrl: "https://github.com/esson/lumen",
  defaultRepoUrl: "https://github.com/esson/lumen",
  currentVersion: "0.1.29",
  targetVersion: "0.1.30",
  message: "Lumen 0.1.30 is available.",
  canCheck: true,
  canInstall: false,
};

const rows = (p: Page) => ready(p, p.locator("tbody tr"));

/** Right-click the library row titled `title`. */
async function rowMenu(page: Page, title: string) {
  await page.locator("tbody tr").filter({ has: page.getByTitle(title, { exact: true }) }).click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor();
  return menu;
}

async function openSettings(page: Page, section?: string) {
  await page.locator(".topbar").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog").getByText("Appearance").first().waitFor();
  if (section) await page.locator(".settings-nav-item", { hasText: section }).click();
}

const MENU_TRACK = "The Lighthouse Keeper's Daughter Never Learned to Swim";
const LINKED_TRACK = "Everything You Left in the Glovebox";

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
  // Overlays, opened over the library (where signing in leaves the app).
  {
    name: "palette",
    wait: rows,
    act: async (p) => {
      await p.keyboard.press("Control+k");
      await ready(p, p.locator(".cmdk-list [cmdk-item]"));
    },
  },
  {
    name: "palette-filter",
    wait: rows,
    act: async (p) => {
      await p.keyboard.press("Control+k");
      await p.locator("[cmdk-input]").fill("p");
      await ready(p, p.locator(".cmdk-list [cmdk-item]"));
    },
  },
  {
    name: "palette-search",
    wait: rows,
    act: async (p) => {
      await p.keyboard.press("Control+k");
      await p.locator("[cmdk-input]").fill("weather");
      await ready(p, p.locator("[cmdk-group-heading]", { hasText: "Tracks" }));
      await p.locator("[cmdk-loading]").waitFor({ state: "detached" });
    },
  },
  { name: "settings", wait: rows, act: (p) => openSettings(p) },
  { name: "settings-playback", wait: rows, act: (p) => openSettings(p, "Playback") },
  {
    name: "settings-connections",
    wait: rows,
    act: async (p) => {
      await openSettings(p, "Connections");
      await p.getByText("Scrobbling as", { exact: false }).waitFor();
    },
  },
  {
    name: "settings-search",
    wait: rows,
    act: async (p) => {
      await openSettings(p);
      await p.getByRole("dialog").getByPlaceholder("Search settings").fill("de");
    },
  },
  { name: "settings-desktop", bridge: { config: desktopConfig }, wait: rows, act: (p) => openSettings(p, "Desktop") },
  {
    name: "settings-discord",
    bridge: { config: desktopConfig },
    wait: rows,
    act: async (p) => {
      await openSettings(p, "Discord");
      await p.getByRole("button", { name: "Show preview" }).waitFor();
    },
  },
  {
    name: "settings-discord-side",
    bridge: { config: desktopConfig },
    wait: rows,
    act: async (p) => {
      await openSettings(p, "Discord");
      await p.getByRole("button", { name: "Show preview" }).click();
      await p.locator(".settings-side .discord-popout").waitFor();
    },
  },
  {
    name: "settings-updates",
    bridge: { update: updateAvailable },
    wait: rows,
    act: (p) => openSettings(p, "Updates"),
  },
  {
    name: "upload",
    wait: rows,
    act: async (p) => {
      await p.locator(".topbar").getByRole("button", { name: "Add music", exact: true }).click();
      await p.getByRole("dialog").getByText("Drop files here", { exact: false }).waitFor();
    },
  },
  {
    name: "confirm",
    wait: rows,
    act: async (p) => {
      const menu = await rowMenu(p, MENU_TRACK);
      await menu.getByRole("menuitem", { name: "Remove from library" }).click();
      await p.getByRole("alertdialog").getByRole("button", { name: "Remove" }).waitFor();
    },
  },
  {
    name: "share",
    wait: rows,
    act: async (p) => {
      const menu = await rowMenu(p, MENU_TRACK);
      await menu.getByRole("menuitem", { name: "Share" }).click();
      await p.getByRole("dialog").getByText("Clip window").first().waitFor();
    },
  },
  {
    name: "track-info",
    wait: rows,
    act: async (p) => {
      const menu = await rowMenu(p, MENU_TRACK);
      await menu.getByRole("menuitem", { name: "Song info" }).click();
      await ready(p, p.getByRole("dialog").getByText("flac", { exact: false }));
    },
  },
  {
    name: "track-info-linked",
    wait: rows,
    act: async (p) => {
      const menu = await rowMenu(p, LINKED_TRACK);
      await menu.getByRole("menuitem", { name: "Song info" }).click();
      await ready(p, p.getByRole("dialog").getByRole("button", { name: /^Unlink / }));
    },
  },
  {
    name: "edit-track",
    wait: rows,
    act: async (p) => {
      const menu = await rowMenu(p, MENU_TRACK);
      await menu.getByRole("menuitem", { name: "Edit metadata" }).click();
      await p.getByRole("dialog").getByText("Album artist").first().waitFor();
    },
  },
  {
    name: "move-album",
    wait: rows,
    act: async (p) => {
      const menu = await rowMenu(p, MENU_TRACK);
      await menu.getByRole("menuitem", { name: "Move to album…" }).click();
      await ready(p, p.getByRole("dialog").getByText("Current"));
    },
  },
  {
    name: "edit-album",
    path: "/library?album=al-weather",
    wait: (p) => ready(p, p.getByRole("button", { name: "Edit album" })),
    act: async (p) => {
      await p.getByRole("button", { name: "Edit album" }).click();
      await p.getByRole("dialog").getByText("Cover art").waitFor();
    },
  },
  { name: "toast", bridge: { update: updateAvailable }, wait: rows, act: (p) => p.locator(".update-toast").waitFor() },
];

for (const scene of SCENES) {
  test(scene.name, async ({ page }, info) => {
    await stubElectron(page, scene.bridge);
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
