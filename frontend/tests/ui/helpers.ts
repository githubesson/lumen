import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, type TestInfo } from "playwright/test";
import { expectUI } from "lintapple/playwright";
import { expectAllMocked, mockApi } from "./mock-api";
import { tracks } from "./fixtures";

/** The track the signed-in screens show in the player bar. */
export const loadedTrack = tracks[0];

/** Signed-out visitor: the API answers /me with 401. */
export async function signedOut(page: Page): Promise<void> {
  await mockApi(page, { signedIn: false });
}

/**
 * Signs in as the admin fixture user and leaves a track loaded and paused in
 * the player bar. The player keeps no queue across reloads, so this plays a
 * library row (the stream is generated silence) and later screens are reached
 * with client-side navigation (`go`) rather than `page.goto`.
 */
export async function signedIn(page: Page): Promise<void> {
  await mockApi(page, { signedIn: true });
  await page.goto("/library");
  const title = page.locator(".track-title").and(page.getByTitle(loadedTrack.title, { exact: true }));
  await title.dispatchEvent("click");
  const bar = page.locator(".player-bar");
  await expect(bar).toHaveAttribute("data-has-track", "true");
  // Wait for the stream's length to land, then pause so the clock stands still.
  await expect(bar).toContainText(formatDuration(loadedTrack.duration_ms));
  if ((await bar.getAttribute("data-playing")) === "true") {
    await bar.getByRole("button", { name: "Pause", exact: true }).dispatchEvent("click");
  }
  await expect(bar).toHaveAttribute("data-playing", "false");
  await expect(bar.locator(".np-error")).toHaveCount(0);
}

/** In-app navigation that keeps the player's state, like following a link. */
export async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/**
 * Waits for `content` and for every loading placeholder to go. Content only
 * has to be attached: on a squeezed layout real text can have no width.
 */
export async function ready(page: Page, content: Locator): Promise<void> {
  await content.first().waitFor({ state: "attached" });
  await expect(page.locator(".loading-state, [aria-busy='true']")).toHaveCount(0);
}

/**
 * Waits for the frame to stop changing: covers in view decoded (they fade in
 * once loaded) and every finite animation and transition finished, so
 * opacity and contrast are measured at their resting values.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frame();
    const inView = [...document.images].filter((img) => {
      const r = img.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    });
    await Promise.all(inView.map((img) => img.decode().catch(() => {})));
    await frame();
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
    await frame();
  });
}

/** A lintapple policy exception, with the reason it is safe. */
export interface PolicyException {
  selector: string;
  rules: string[];
  reason: string;
}

const policy = JSON.parse(readFileSync(new URL("../../ui-policy.json", import.meta.url), "utf8")) as {
  exceptions: PolicyException[];
};

/**
 * On phones the track tables scroll sideways, and axe errors on the sticky
 * headers of columns scrolled out of view. Applied only at phone widths, so
 * the headers it can see stay checked.
 */
const offscreenTableHeaders: PolicyException = {
  selector: ".table-scroll thead th",
  rules: ["text-contrast"],
  reason: "Sticky headers of columns scrolled out of view, which axe errors on. They share the style of the headers it measures in view.",
};

/**
 * Settles the page, saves a screenshot when LINT_UI_SHOTS names a directory
 * (1440px projects only), then runs lintapple against ui-policy.json plus
 * any `exceptions` this one check needs. API calls without a fixture fail
 * the test too.
 */
export async function checkUI(page: Page, testInfo: TestInfo, { exceptions = [] }: { exceptions?: PolicyException[] } = {}): Promise<void> {
  await settle(page);
  expectAllMocked(page, testInfo);
  const shots = process.env.LINT_UI_SHOTS;
  if (shots && page.viewportSize()?.width === 1440) {
    mkdirSync(shots, { recursive: true });
    const scheme = testInfo.project.name.split(" ").pop();
    const name = `${testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${scheme}.png`;
    await page.screenshot({ path: join(shots, name) });
  }
  const phone = (page.viewportSize()?.width ?? Infinity) <= 760;
  await expectUI(page, testInfo, {
    ...policy,
    exceptions: [...policy.exceptions, ...exceptions, ...(phone ? [offscreenTableHeaders] : [])],
  });
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
