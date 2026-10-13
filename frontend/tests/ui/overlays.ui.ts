import { expect, test, type Page } from "playwright/test";
import { tracks } from "./fixtures";
import { checkUI, loadedTrack, ready, settle, signedIn } from "./helpers";

// Overlays open over the library's track list (where `signedIn` leaves the
// app), so their reports also include that page's findings.
test.beforeEach(async ({ page }) => {
  await signedIn(page);
  await ready(page, page.locator("tbody tr"));
  await settle(page);
});

const menuTrack = tracks.find((t) => t.id === "t-al-weather-4")!;

async function openContextMenu(page: Page) {
  await page.locator("tbody tr").filter({ has: page.getByTitle(menuTrack.title, { exact: true }) }).click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor();
  return menu;
}

test("track context menu", async ({ page }, testInfo) => {
  await openContextMenu(page);
  await checkUI(page, testInfo);
});

// Right-clicking a row inside a selection opens the menu for all of it.
test("track selection menu", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const rows = page.locator("tbody tr");
  for (const index of [1, 3, 5]) await rows.nth(index).locator(".track-title").click();
  await rows.nth(3).locator(".track-title").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "3 tracks" });
  await menu.waitFor();
  await expect(menu.getByRole("menuitem", { name: "Export" })).toBeVisible();
  await checkUI(page, testInfo);
});

test("track info dialog", async ({ page }, testInfo) => {
  const menu = await openContextMenu(page);
  await menu.getByRole("menuitem", { name: "Song info" }).click();
  const dialog = page.getByRole("dialog");
  await ready(page, dialog.getByText("flac", { exact: false }));
  await expect(dialog).toContainText(menuTrack.title);
  await checkUI(page, testInfo);
});

test("settings dialog", async ({ page }, testInfo) => {
  // Below 760px Settings lives in the navigation drawer.
  const topbar = page.locator(".topbar").getByRole("button", { name: "Settings", exact: true });
  if (!(await topbar.isVisible())) {
    await page.getByRole("button", { name: "Open navigation" }).dispatchEvent("click");
  }
  await page.getByRole("button", { name: "Settings", exact: true }).first().dispatchEvent("click");
  await ready(page, page.getByRole("dialog").getByText("Appearance").first());
  await checkUI(page, testInfo);
});

test("queue popover", async ({ page }, testInfo) => {
  await page.locator(".player-bar").getByRole("button", { name: "Queue", exact: true }).dispatchEvent("click");
  await ready(page, page.locator(".queue-pop").getByText(loadedTrack.title).first());
  await checkUI(page, testInfo);
});

test("command palette", async ({ page }, testInfo) => {
  await page.keyboard.press("ControlOrMeta+k");
  await ready(page, page.locator(".cmdk-list [cmdk-item]"));
  await checkUI(page, testInfo);
});

// The app is inert while the palette is open; closing it must still return
// focus to whatever opened it.
test("command palette returns focus", async ({ page }) => {
  const search = page.locator(".topbar-search");
  await search.click();
  await page.locator(".cmdk-list [cmdk-item]").first().waitFor();
  await expect(page.locator(".app")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(page.locator(".app")).not.toHaveAttribute("inert");
  await expect(search).toBeFocused();
});

test("lyrics panel", async ({ page }, testInfo) => {
  await page.locator(".topbar").getByRole("button", { name: "Toggle lyrics panel" }).click();
  await ready(page, page.locator(".lyrics-sidebar").getByText("the kettle's still warm", { exact: false }));
  await checkUI(page, testInfo);
});

test("phone lyrics drawer closes on Escape and outside taps", async ({ page }) => {
  test.skip(page.viewportSize()!.width > 760, "The panel is a drawer only on phones.");
  const toggle = page.locator(".topbar").getByRole("button", { name: "Toggle lyrics panel" });
  const panel = page.locator(".lyrics-sidebar");
  await toggle.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(panel).toBeVisible();
  // The backdrop, left of the drawer.
  await page.mouse.click(16, page.viewportSize()!.height / 2);
  await expect(panel).toBeHidden();
});
