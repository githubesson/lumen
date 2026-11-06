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
  { name: "admin", path: "/admin", wait: (p) => ready(p, p.locator(".admin-section-wrap tbody tr")) },
  ...adminScenes(),
  { name: "login", signedOut: true, path: "/login", wait: (p) => ready(p, p.locator("form")) },
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
