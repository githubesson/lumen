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

/**
 * The desktop bridge as the Windows build's preload exposes it. `config`
 * overrides `getConfig`'s answer (`backendUrl: ""` is a first run), and
 * `testServer` answers the Welcome screen's server check.
 */
async function stubElectron(page: Page, config: Record<string, unknown> = {}) {
  await page.addInitScript((overrides) => {
    const base: Record<string, unknown> = {
      isElectron: true,
      platform: "win32",
      getConfig: async () => ({
        backendUrl: location.origin,
        discordEnabled: false,
        alwaysOnTop: false,
        nowPlayingApiEnabled: false,
        ...overrides,
      }),
      testServer: async () => ({ ok: true, url: "http://localhost:8080" }),
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
  }, config);
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
];

for (const scene of SCENES) {
  test(scene.name, async ({ page }, info) => {
    await stubElectron(page, scene.config);
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
    await page.mouse.move(-10, -10);
    await settle(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}${scene.name}-${info.project.name}.png`, omitBackground: true });
  });
}
