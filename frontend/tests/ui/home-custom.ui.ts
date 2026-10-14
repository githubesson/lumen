import { test, type Page } from "playwright/test";
import type { HomeBoardTweak } from "../../src/contracts/desktop";
import { playlists } from "./fixtures";
import { checkUI, go, ready, signedIn } from "./helpers";

// A customized Home with every kind of panel, in sizes the default board
// doesn't use, saved as the app saves it. Seeded before sign-in loads the
// app, since the tweaks are read once at startup.
const board: HomeBoardTweak = {
  panels: [
    { id: "resume", kind: "resume", w: 4, h: 1 },
    { id: "stats", kind: "stats", w: 2, h: 1, period: "this-year" },
    { id: "repeat", kind: "repeat", w: 2, h: 2, title: "Heavy rotation" },
    { id: "activity", kind: "activity", w: 4, h: 1, period: "this-year" },
    { id: "genres", kind: "genres", w: 3, h: 1, period: "this-year" },
    { id: "added", kind: "added", w: 3, h: 1 },
    { id: "top-albums", kind: "top-albums", w: 6, h: 1, period: "all" },
    { id: "playlist", kind: "playlist", w: 3, h: 1, playlist: playlists[0].id },
    { id: "recent", kind: "recent", w: 3, h: 1 },
    { id: "artists", kind: "artists", w: 4, h: 1, period: "this-month" },
    { id: "repeat-2", kind: "repeat", w: 2, h: 1, period: "all" },
    { id: "favorites", kind: "favorites", w: 2, h: 1, hidden: true },
    { id: "albums", kind: "albums", w: 6, h: 1 },
    { id: "playlists", kind: "playlists", w: 6, h: 1, hidden: true },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((homeBoard) => {
    // Saved tweaks skip the system's color scheme, so they carry it.
    const theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    const saved = JSON.parse(localStorage.getItem("lumen.tweaks") ?? "{}");
    localStorage.setItem("lumen.tweaks", JSON.stringify({ theme, ...saved, homeBoard }));
  }, board);
  await signedIn(page);
});

/** Clicks without moving the mouse, so no hover state or tooltip is left behind. */
const press = (page: Page, name: string | RegExp) => page.getByRole("button", { name }).first().dispatchEvent("click");

/** The board with every panel's list in. */
async function boardReady(page: Page) {
  await ready(page, page.locator('[data-panel="artists"] .board-artist'));
  await ready(page, page.locator('[data-panel="playlist"] .board-row:not(.board-placeholder)'));
  await ready(page, page.locator('[data-panel="activity"] .activity-chart'));
}

test("home, every kind of panel", async ({ page }, testInfo) => {
  await go(page, "/");
  await boardReady(page);
  await checkUI(page, testInfo);
});

test("home, adding a panel", async ({ page }, testInfo) => {
  await go(page, "/?customize");
  await boardReady(page);
  await press(page, "Add panel");
  await ready(page, page.getByRole("dialog", { name: "Add a panel" }));
  await checkUI(page, testInfo);
});

test("home, a panel's settings", async ({ page }, testInfo) => {
  await go(page, "/?customize");
  await boardReady(page);
  await press(page, /^Edit\s*Heavy rotation$/);
  await ready(page, page.getByRole("dialog", { name: "Edit Heavy rotation" }));
  await checkUI(page, testInfo);
});

test("home, resetting a board with added panels", async ({ page }, testInfo) => {
  await go(page, "/?customize");
  await boardReady(page);
  await press(page, "Reset");
  await ready(page, page.getByRole("dialog", { name: "Reset Home?" }));
  await checkUI(page, testInfo);
});
