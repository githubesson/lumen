import { expect, test, type Page } from "playwright/test";
import { settle, signedIn } from "./helpers";

// ui-policy.json excuses `[title]` and aria-labelled icon buttons from
// lintapple's icon-button-tooltip rule, because TitleTooltips mounts their
// tooltip only while it shows. This checks that it does show, for the pointer
// and for the keyboard, and that Escape dismisses it.
test.beforeEach(async ({ page }) => {
  await signedIn(page);
  await settle(page);
});

const shown = (page: Page) => page.locator("[role=tooltip]:not([data-closed])");

test("icon button tooltip on hover", async ({ page }) => {
  const next = page.locator(".player-bar").getByRole("button", { name: "Next", exact: true });
  await next.hover();
  await expect(shown(page)).toHaveText("Next");
  await page.keyboard.press("Escape");
  await expect(shown(page)).toHaveCount(0);
});

test("title tooltip on hover", async ({ page }) => {
  await page.locator(".topbar").getByRole("button", { name: "Toggle lyrics panel" }).hover();
  await expect(shown(page)).toHaveText("Lyrics");
});

test("icon button tooltip on keyboard focus", async ({ page }) => {
  const bar = page.locator(".player-bar");
  await bar.getByRole("button", { name: "Play", exact: true }).focus();
  await page.keyboard.press("Tab");
  const next = bar.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeFocused();
  await expect(shown(page)).toHaveText("Next");
  await page.keyboard.press("Escape");
  await expect(shown(page)).toHaveCount(0);
  await expect(next).toBeFocused();
});
