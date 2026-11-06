// One screenshot per scene of the Electron frontend. The Rune app renders the
// same scenes headlessly (`lumen --snap … --scene <name>`), against the same
// fixtures served by tools/mock-server.ts, so the two can be diffed.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, type Page } from "playwright/test";
import { go, ready, settle, signedIn, signedOut } from "../../../frontend/tests/ui/helpers";
import { mockApi } from "../../../frontend/tests/ui/mock-api";
import { me } from "../../../frontend/tests/ui/fixtures";

const OUT = fileURLToPath(new URL("../../out/ref/", import.meta.url));
mkdirSync(OUT, { recursive: true });

/** What a scene changes in the desktop bridge: config fields, and an update status. */
type Bridge = { config?: Record<string, unknown>; update?: Record<string, unknown> };

/**
 * The desktop bridge as the Windows build's preload exposes it. `config`
 * overrides `getConfig`'s answer (`backendUrl: ""` is a first run), `update`
 * is the updater's status, and `testServer` answers Welcome's server check.
 */
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
      testServer: async () => ({ ok: true, url: "http://localhost:8080" }),
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
  /** Signed in without the harness's loaded track (no detour through /library). */
  bare?: boolean;
  /** `getConfig` overrides for the desktop bridge. */
  config?: Record<string, unknown>;
  /** Route overrides, registered after the API mock so they win. */
  setup?: (page: Page) => Promise<void>;
  /** Waits for the scene's own content before the shot. */
  wait?: (page: Page) => Promise<void>;
  act?: (page: Page) => Promise<void>;
  /** Window size, when not the default 1280×820. */
  size?: { width: number; height: number };
  /** Skip `settle` (it waits on every finite animation) and just wait. */
  noSettle?: boolean;
  /** Leave the pointer where `act` put it (hover states). */
  keepPointer?: boolean;
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

  // Before sign-in (App.tsx's gating) and the public share page.
  {
    name: "login-error",
    signedOut: true,
    path: "/login",
    setup: (p) => p.route("**/api/auth/login", (r) => r.fulfill({ status: 401, contentType: "text/plain", body: "invalid credentials" })),
    wait: (p) => ready(p, p.locator("form")),
    act: async (p) => {
      await p.getByLabel("Username").fill("maya");
      await p.getByLabel("Password").fill("wrongpass");
      await p.getByLabel("Password").press("Enter");
      await p.getByRole("alert").waitFor();
    },
  },
  { name: "register", signedOut: true, path: "/register", wait: (p) => ready(p, p.getByText("Invite unavailable")) },
  { name: "register-invite", signedOut: true, path: "/register?token=inv-123", wait: (p) => ready(p, p.locator("form")) },
  {
    name: "reset-password",
    bare: true,
    path: "/reset-password",
    setup: (p) => p.route("**/api/auth/me", (r) => r.fulfill({ json: { ...me, must_reset_password: true } })),
    wait: (p) => ready(p, p.locator("form")),
  },
  {
    name: "welcome",
    signedOut: true,
    path: "/login",
    config: { backendUrl: "", discordEnabled: true },
    wait: (p) => ready(p, p.getByText("Welcome to Lumen")),
  },
  {
    name: "welcome-server",
    signedOut: true,
    path: "/login",
    config: { backendUrl: "", discordEnabled: true },
    wait: (p) => ready(p, p.getByText("Welcome to Lumen")),
    act: async (p) => {
      await p.getByRole("button", { name: "Get started" }).click();
      await p.getByLabel("Server address").waitFor();
    },
  },
  {
    name: "welcome-prefs",
    signedOut: true,
    path: "/login",
    config: { backendUrl: "", discordEnabled: true },
    wait: (p) => ready(p, p.getByText("Welcome to Lumen")),
    act: async (p) => {
      await p.getByRole("button", { name: "Get started" }).click();
      await p.getByLabel("Server address").fill("localhost:8080");
      await p.getByRole("button", { name: "Continue" }).click();
      await p.getByText("A few preferences").waitFor();
    },
  },
  {
    name: "welcome-change",
    signedOut: true,
    path: "/login",
    wait: (p) => ready(p, p.locator("form")),
    act: async (p) => {
      await p.getByRole("button", { name: "Change server" }).click();
      await p.getByText("Switching servers signs you out of this one.").waitFor();
    },
  },
  {
    name: "startup-loading",
    signedOut: true,
    path: "/",
    // /me never answers.
    setup: (p) => p.route("**/api/auth/me", () => {}),
    wait: (p) => ready(p, p.getByText("Connecting to your library")),
  },
  {
    name: "startup-unreachable",
    signedOut: true,
    path: "/",
    setup: (p) => p.route("**/api/auth/me", (r) => r.abort("connectionrefused")),
    wait: (p) => ready(p, p.getByText("Your server is unavailable")),
  },
  {
    name: "share",
    signedOut: true,
    path: "/shared/track/t-al-weather-1?t=45&d=30&sig=4b1d9e",
    wait: (p) => ready(p, p.locator(".share-preview-card")),
  },
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
    await stubElectron(page, { config: scene.config ?? scene.bridge?.config, update: scene.bridge?.update });
    if (scene.size) await page.setViewportSize(scene.size);
    if (scene.signedOut || scene.bare) {
      if (scene.signedOut) await signedOut(page);
      else await mockApi(page, { signedIn: true });
      await scene.setup?.(page);
      await page.goto(scene.path ?? "/login");
    } else {
      await signedIn(page);
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
