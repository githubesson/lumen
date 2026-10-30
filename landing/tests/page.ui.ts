import { test, type Page } from "playwright/test";
import { expectUI } from "lintapple/playwright";

test.beforeEach(async ({ page }) => {
  // Fixed GitHub data keeps the run offline and renders the stars and the
  // release tag.
  await page.route("https://api.github.com/repos/**", (route) => {
    const releases = new URL(route.request().url()).pathname.endsWith("/releases");
    return route.fulfill({
      json: releases
        ? [{ tag_name: "v0.1.14", html_url: "https://github.com/githubesson/lumen/releases/tag/v0.1.14", prerelease: false }]
        : { stargazers_count: 128 },
    });
  });
  // Relative, so a LANDING_BASE sub-path is kept.
  await page.goto("./");
  await page.locator("#faq").waitFor();
});

/** Scrolls through the page so every `.reveal` section is shown, then waits
 *  for entrance fades to end so contrast is measured at full opacity. */
async function revealAll(page: Page) {
  await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight / 2) {
      scrollTo(0, y);
      await frame();
    }
    scrollTo(0, 0);
    await frame();
  });
  // Only rendered sections can scroll into view; one hidden at this width
  // never would.
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".reveal")].every((el) => el.hasAttribute("data-shown") || !el.checkVisibility()),
  );
  await settle(page);
}

async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
}

test("page", async ({ page }, testInfo) => {
  await revealAll(page);
  await expectUI(page, testInfo);
});

test("mobile menu", async ({ page }, testInfo) => {
  const toggle = page.getByRole("button", { name: "Open menu" });
  test.skip(!(await toggle.isVisible()), "The menu button shows only below the md breakpoint.");
  await revealAll(page);
  await toggle.click();
  await page.getByRole("button", { name: "Close menu" }).waitFor();
  await settle(page);
  await expectUI(page, testInfo);
});
