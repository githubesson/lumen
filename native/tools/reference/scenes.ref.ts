// One screenshot per scene of the Electron frontend. The Rune app renders the
// same scenes headlessly (`lumen --snap … --scene <name>`), against the same
// fixtures served by tools/mock-server.ts, so the two can be diffed.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, type Page } from "playwright/test";
import { go, ready, settle, signedIn, signedOut } from "../../../frontend/tests/ui/helpers";
import { mockApi } from "../../../frontend/tests/ui/mock-api";
import { artistGridPins, me, tracks } from "../../../frontend/tests/ui/fixtures";

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
  /** `tweaks.homeBoard` to seed before sign-in (Home's saved arrangement). */
  homeBoard?: unknown;
  /** Runs before the app loads (init scripts, exposed functions). */
  beforeLoad?: (page: Page) => Promise<void>;
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
/** The playlist page's own track rows (not the library's, still up as it opens). */
const playlistRows = (p: Page) => ready(p, p.locator(".view:has(.playlist-toolbar) tbody tr"));
/** Picks a tab without moving the mouse (no hover left behind). */
const tab = (p: Page, name: string | RegExp) => p.getByRole("tab", { name }).first().dispatchEvent("click");

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

/** Every panel hidden. */
const HIDDEN_BOARD = {
  panels: ["resume", "repeat", "recent", "favorites", "albums", "playlists", "artists"].map((id) => ({
    id,
    kind: id,
    w: id === "resume" || id === "albums" ? 4 : id === "artists" ? 6 : 2,
    h: id === "repeat" ? 2 : 1,
    hidden: true,
  })),
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
  { name: "home-empty", path: "/", homeBoard: HIDDEN_BOARD, wait: (p) => ready(p, p.locator(".board-empty")) },
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
  { name: "admin", path: "/admin", wait: (p) => ready(p, p.locator(".admin-section-wrap tbody tr")) },
  ...adminScenes(),
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
  // Playlists: one owned private, one owned collaborative, one shared with
  // the user as an editor (fixtures.ts), each on its tabs.
  { name: "playlist-owned", path: "/playlists/pl-night-drives", wait: playlistRows },
  { name: "playlist-collab", path: "/playlists/pl-sunday-coffee", wait: playlistRows },
  { name: "playlist-shared", path: "/playlists/pl-road-trip", wait: playlistRows },
  {
    name: "playlist-collaborators",
    path: "/playlists/pl-sunday-coffee",
    wait: playlistRows,
    act: async (p) => {
      await tab(p, /^Collaborators/);
      await ready(p, p.getByText("theo", { exact: true }));
    },
  },
  {
    name: "playlist-shared-collaborators",
    path: "/playlists/pl-road-trip",
    wait: playlistRows,
    act: async (p) => {
      await tab(p, /^Collaborators/);
      await ready(p, p.getByText("priya", { exact: true }));
    },
  },
  {
    name: "playlist-settings",
    path: "/playlists/pl-sunday-coffee",
    wait: playlistRows,
    act: async (p) => {
      await tab(p, "Settings");
      await ready(p, p.getByRole("textbox", { name: "Name" }));
    },
  },
  {
    name: "playlist-shared-settings",
    path: "/playlists/pl-road-trip",
    wait: playlistRows,
    act: async (p) => {
      await tab(p, "Settings");
      await ready(p, p.getByText("Save TIDAL tracks to the library"));
    },
  },
  {
    name: "playlist-add",
    path: "/playlists/pl-night-drives",
    wait: playlistRows,
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
    wait: playlistRows,
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
  // The Library page's tabs, toolbar states and drill-down pages.
  {
    name: "library-grid",
    path: "/library",
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await p.getByRole("tab", { name: "Grid" }).click();
      await ready(p, p.locator(".card"));
    },
  },
  {
    name: "library-select",
    path: "/library",
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await p.locator(".toolbar-group").getByRole("button", { name: "Select", exact: true }).click();
    },
  },
  {
    name: "library-sort",
    path: "/library",
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await p.getByRole("combobox", { name: "Sort" }).click();
      await p.getByRole("listbox").waitFor();
    },
  },
  { name: "library-search", path: "/library?q=harbour", wait: (p) => ready(p, p.locator("tbody tr")) },
  { name: "library-album", path: "/library?album=al-weather", wait: (p) => ready(p, p.locator("tbody tr")) },
  {
    name: "library-album-medium",
    path: "/library?album=al-lanterns",
    size: { width: 900, height: 700 },
    wait: (p) => ready(p, p.locator("tbody tr")),
  },
  { name: "library-artist", path: "/library?artist=ar-velvet", wait: (p) => ready(p, p.locator("tbody tr")) },
  {
    name: "library-tidal-album",
    path: "/library?tidalAlbum=381245566&tidalArtist=4419021",
    wait: (p) => ready(p, p.locator("tbody tr")),
  },
  { name: "library-tidal-saved", path: "/library?tidalAlbum=310077120", wait: (p) => ready(p, p.locator("tbody tr")) },
  {
    name: "library-tidal-artist",
    path: "/library?tidalArtist=4419021&artistName=Marisol%20Vey",
    wait: (p) => ready(p, p.locator(".card")),
  },
  {
    name: "library-album-missing",
    path: "/library?album=missing",
    wait: (p) => ready(p, p.getByText("Album not found.")),
  },
  {
    name: "library-tidal-missing",
    path: "/library?tidalAlbum=404404",
    wait: (p) => ready(p, p.getByText("TIDAL album unavailable.")),
  },
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
    name: "share-preview",
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

/** The admin page: each section, the library section scrolled, every dialog. */
function adminScenes(): Scene[] {
  const lib = (p: Page) => ready(p, p.locator(".admin-section-wrap tbody tr"));
  const scroll = (y: number) => async (p: Page) => {
    await p.locator(".content").evaluate((el, top) => el.scrollTo({ top }), y);
  };
  const press = (label: string) => async (p: Page) => {
    await p.getByRole("button", { name: label, exact: true }).click();
  };
  return [
    { name: "admin-lib-2", path: "/admin", wait: lib, act: scroll(600) },
    { name: "admin-lib-3", path: "/admin", wait: lib, act: scroll(1200) },
    { name: "admin-lib-4", path: "/admin", wait: lib, act: scroll(1800) },
    { name: "admin-lib-5", path: "/admin", wait: lib, act: scroll(2400) },
    {
      name: "admin-errors",
      path: "/admin",
      wait: lib,
      act: async (p) => {
        await p.getByRole("button", { name: /Files that failed to import/ }).click();
        await scroll(300)(p);
      },
    },
    {
      name: "admin-downloads",
      path: "/admin",
      wait: lib,
      act: async (p) => {
        await p.getByRole("button", { name: /Recent downloads/ }).click();
        await scroll(1200)(p);
      },
    },
    { name: "admin-remove-folder", path: "/admin", wait: lib, act: press("Remove /mnt/nas/uploads/lossless") },
    { name: "admin-unlink", path: "/admin", wait: lib, act: async (p) => {
      await scroll(600)(p);
      await press("Unlink")(p);
    } },
    {
      name: "admin-link-flow",
      path: "/admin",
      wait: lib,
      act: async (p) => {
        await p.evaluate(() => {
          (window as unknown as { electron: Record<string, unknown> }).electron.openExternal = async () => ({ ok: true });
        });
        await p.route("**/api/admin/tidal/auth", (r) =>
          r.fulfill({
            json: {
              flow_id: "flow-1",
              verification_url: "https://link.tidal.com/KXQZP",
              user_code: "KXQZP",
              expires_at: "2099-01-01T00:00:00Z",
            },
          }),
        );
        await p.route("**/api/admin/tidal/auth/flow-1", (r) => r.fulfill({ json: { state: "pending" } }));
        await scroll(600)(p);
        await press("Link account")(p);
        await p.getByText("Finish signing in to TIDAL").waitFor();
      },
    },
    {
      // The fixtures' pin ids aren't UUIDs, so their actions stay disabled:
      // give the ArtistGrid pin a real one and open its history.
      name: "admin-pin-history",
      path: "/admin",
      wait: lib,
      act: async (p) => {
        const id = "3f1c9a2e-77b4-4c1e-9d0a-5be1f2c8a901";
        await p.route("**/api/admin/library/artistgrid/pins", (r) =>
          r.fulfill({ json: artistGridPins.map((pin) => ({ ...pin, id })) }),
        );
        await p.route(`**/api/admin/library/artistgrid/pins/${id}/downloads*`, (r) =>
          r.fulfill({
            json: [
              { id: 1, pin_id: id, source_url: "https://artistgrid.example.org/velvet-meridian/demo-1.flac", file_path: "/music/artistgrid/velvet-meridian/Demo 1.flac", status: "downloaded", first_seen_at: "2026-10-10T18:00:00Z", updated_at: "2026-10-10T18:00:00Z" },
              { id: 2, pin_id: id, source_url: "https://artistgrid.example.org/velvet-meridian/demo-2.flac", status: "failed", error: "HTTP 404 Not Found", first_seen_at: "2026-10-10T18:00:00Z", updated_at: "2026-10-10T18:01:00Z" },
            ],
          }),
        );
        // Remount the section so the pins load through the override.
        await p.locator(".segmented button", { hasText: "Users" }).click();
        await p.locator(".segmented button", { hasText: "Library" }).click();
        await p.getByRole("button", { name: "Download history for Velvet Meridian demos" }).click();
        await p.getByText("No download records yet.").or(p.getByText("Demo 1.flac", { exact: false })).first().waitFor();
        await scroll(1900)(p);
      },
    },
    {
      name: "admin-users",
      path: "/admin?section=users",
      wait: (p) => ready(p, p.locator(".admin-section-wrap tbody tr")),
    },
    {
      name: "admin-disable-user",
      path: "/admin?section=users",
      wait: (p) => ready(p, p.locator(".admin-section-wrap tbody tr")),
      act: press("Disable jonas"),
    },
    {
      name: "admin-delete-user",
      path: "/admin?section=users",
      wait: (p) => ready(p, p.locator(".admin-section-wrap tbody tr")),
      act: async (p) => {
        await p.route("**/api/admin/users/u-jonas/departure-preview", (r) =>
          r.fulfill({
            json: {
              user_id: "u-jonas",
              username: "jonas",
              owned_playlists: [
                { playlist_id: "pl-jonas-running", name: "Jonas's Running Mix — 170 BPM and Up", suggested_heir_id: "u-priya", has_collaborators: true },
                { playlist_id: "pl-jonas-focus", name: "Deep Focus", has_collaborators: false },
              ],
            },
          }),
        );
        await press("Delete jonas")(p);
        await p.getByText("Choose what happens to each").waitFor();
      },
    },
    {
      name: "admin-invites",
      path: "/admin?section=invites",
      wait: (p) => ready(p, p.locator(".admin-section-wrap tbody tr")),
    },
    {
      name: "admin-invites-past",
      path: "/admin?section=invites",
      wait: (p) => ready(p, p.locator(".admin-section-wrap tbody tr")),
      act: async (p) => {
        await p.getByRole("button", { name: /Used, expired and revoked/ }).click();
      },
    },
    {
      name: "admin-invite-created",
      path: "/admin?section=invites",
      wait: (p) => ready(p, p.locator(".admin-section-wrap tbody tr")),
      act: async (p) => {
        await p.route("**/api/admin/invites", (r) =>
          r.request().method() === "POST"
            ? r.fulfill({
                json: { id: "inv-9", token: "lmn_Nw5RtY8uLp2KqX7c", target_role: "user", max_uses: 1, uses: 0, expires_at: null, created_at: "2026-10-11T09:00:00Z" },
              })
            : r.fallback(),
        );
        await press("Create")(p);
        await p.getByText("Invite ready").waitFor();
      },
    },
    {
      name: "admin-revoke-invite",
      path: "/admin?section=invites",
      wait: (p) => ready(p, p.locator(".admin-section-wrap tbody tr")),
      act: async (p) => {
        await p.getByRole("button", { name: /^Revoke user invite/ }).click();
      },
    },
  ];
}


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
    beforeLoad: miniWindow,
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: enterMini,
  },
  {
    name: "mini-queue",
    path: "/library",
    beforeLoad: miniWindow,
    wait: (p) => ready(p, p.locator("tbody tr")),
    act: async (p) => {
      await enterMini(p);
      await openMiniPanel(p, "Queue");
    },
  },
  {
    name: "mini-lyrics",
    path: "/library",
    beforeLoad: miniWindow,
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
    beforeLoad: miniWindow,
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
    beforeLoad: miniWindow,
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
    await stubElectron(page, { config: scene.config ?? scene.bridge?.config, update: scene.bridge?.update });
    await scene.beforeLoad?.(page);
    if (scene.homeBoard) {
      // Saved tweaks skip the system's colour scheme, so they carry it.
      await page.addInitScript((homeBoard) => {
        const theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        const saved = JSON.parse(localStorage.getItem("lumen.tweaks") ?? "{}");
        localStorage.setItem("lumen.tweaks", JSON.stringify({ theme, ...saved, homeBoard }));
      }, scene.homeBoard);
    }
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
