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

// Destructive actions ask in the app's own dialog, never the browser's. The
// menu closes as it opens.
test("confirm dialog", async ({ page }, testInfo) => {
  let nativeDialogs = 0;
  page.on("dialog", (native) => {
    nativeDialogs += 1;
    void native.dismiss();
  });
  const menu = await openContextMenu(page);
  await menu.getByRole("menuitem", { name: "Remove from library" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove for everyone?" });
  await ready(page, dialog.getByRole("button", { name: "Remove" }));
  await expect(dialog).toContainText(menuTrack.title);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(nativeDialogs).toBe(0);
  await checkUI(page, testInfo);
});

// The palette is a Radix modal whose focus trap would pull focus straight
// back out of a dialog opened over it, leaving Enter to run the palette's
// highlighted item underneath. The confirmation must hold the keyboard.
test("confirm dialog over the command palette", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.locator("[cmdk-input]");
  await input.fill(menuTrack.title);
  const result = page.locator(".cmdk-list [cmdk-item]").filter({ hasText: menuTrack.title }).first();
  await result.click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Remove from library" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove for everyone?" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Remove" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  // Answers the dialog. The palette stays up with the search as it was, and
  // focus goes back into it.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("[cmdk-dialog]")).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[cmdk-dialog]"))).toBe(true);
  await expect(input).toHaveValue(menuTrack.title);
  await expect(page.locator(".player-bar")).not.toContainText(menuTrack.title);
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
