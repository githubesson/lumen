import { expect, test, type Page } from "playwright/test";
import type { DesktopConfig, DesktopConfigPatch } from "../../src/contracts/desktop";
import { checkUI, ready, settle, signedIn } from "./helpers";

// Settings sections only the desktop app has. A stand-in for the Electron
// bridge serves the desktop config and records what Settings saves.
const config: DesktopConfig = {
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
  nowPlayingApiEnabled: false,
  nowPlayingApiUrl: "",
  nowPlayingApiToken: "first-token-0123456789",
  nowPlayingApiError: "",
};

async function desktopBridge(page: Page) {
  await page.addInitScript((config) => {
    const saves: DesktopConfigPatch[] = [];
    Object.assign(window, { desktopSaves: saves, desktopConfig: config });
    const bridge: Record<string, unknown> = {
      isElectron: true,
      platform: "win32",
      getConfig: async () => config,
      updateConfig: async ({ discordCard, ...patch }: DesktopConfigPatch) => {
        saves.push({ discordCard, ...patch });
        // Like the desktop app, merge the card options sent onto the saved card.
        Object.assign(config, patch, { discordCard: { ...config.discordCard, ...discordCard } });
        if (patch.nowPlayingApiEnabled !== undefined) {
          config.nowPlayingApiUrl = patch.nowPlayingApiEnabled ? "http://127.0.0.1:48638" : "";
        }
        return { ok: true, config: { ...config }, changed: false };
      },
      getSignOutIntent: async () => false,
      newNowPlayingApiToken: async () => ({ ...Object.assign(config, { nowPlayingApiToken: "second-token-0123456789" }) }),
      setDiscordActivity: async () => ({ ok: true }),
      clearDiscordActivity: async () => ({ ok: true }),
      // Optional methods an older desktop build lacks: absent, so the app
      // keeps tweaks in localStorage and skips the updater.
      getTweaks: undefined,
      saveTweaks: undefined,
      getUpdateStatus: undefined,
      onUpdateStatus: undefined,
    };
    // Window chrome and the rest of the bridge answer with a plain success.
    window.electron = new Proxy(bridge, {
      get: (target, key: string) => (key in target ? target[key] : async () => ({ ok: true })),
    }) as unknown as typeof window.electron;
  }, config);
}

async function openSection(page: Page, name: string) {
  // Below 760px Settings lives in the navigation drawer.
  const topbar = page.locator(".topbar").getByRole("button", { name: "Settings", exact: true });
  if (!(await topbar.isVisible())) {
    await page.getByRole("button", { name: "Open navigation" }).dispatchEvent("click");
  }
  await page.getByRole("button", { name: "Settings", exact: true }).first().dispatchEvent("click");
  await page.locator(".settings-nav-item", { hasText: name }).click();
}

const desktopExceptions = [
  {
    selector: ".window-control",
    rules: ["control-gap"],
    reason: "The title bar's minimize, maximize and close sit edge to edge like the system's own; each is 46px wide.",
  },
  {
    selector: "[role=switch]",
    rules: ["icon-button-tooltip"],
    reason: "Switch is named by its settings row's visible label (aria-labelledby), which sits beside it.",
  },
  {
    selector: ".discord-preview, .discord-preview *",
    rules: ["font-family"],
    reason: "A replica of Discord's profile popout, in Discord's own font stack so it reads as Discord's.",
  },
];

test.beforeEach(async ({ page }) => {
  await desktopBridge(page);
  await signedIn(page);
  await ready(page, page.locator("tbody tr"));
  await settle(page);
});

test("discord settings", async ({ page }, testInfo) => {
  await openSection(page, "Discord");
  await ready(page, page.locator(".discord-popout"));
  // With room beside the dialog the preview goes in a side column, shut until
  // the heading's toggle opens it, so it stays in view while the options
  // scroll; otherwise it heads the section.
  const side = (page.viewportSize()?.width ?? 0) >= 1100;
  const toggle = page.getByRole("button", { name: "Show preview" });
  await expect(toggle).toHaveCount(side ? 1 : 0);
  if (side) {
    await expect(page.locator(".settings[data-side]")).toHaveCount(0);
    await checkUI(page, testInfo, { exceptions: desktopExceptions });
    await toggle.click();
    await expect(page.getByRole("button", { name: "Hide preview" })).toBeVisible();
  }
  await expect(page.locator(side ? ".settings-side .discord-popout" : ".settings-pane .discord-popout")).toBeVisible();
  await expect(page.locator(".settings[data-side]")).toHaveCount(side ? 1 : 0);
  await checkUI(page, testInfo, {
    exceptions: [
      ...desktopExceptions,
      {
        selector: ".discord-lines .input",
        rules: ["text-contrast"],
        reason: "The card's line fields start below the fold of the scrolling settings pane, where lintapple's placeholder check finds no background. The next check scrolls them into view.",
      },
    ],
  });
  await page.locator(".settings-pane").evaluate((pane) => pane.scrollTo(0, pane.scrollHeight));
  await settle(page);
  await checkUI(page, testInfo, { exceptions: desktopExceptions });
});

test("discord card preview follows its lines", async ({ page }) => {
  await openSection(page, "Discord");
  await page.getByRole("textbox", { name: "Line 2" }).fill("{artist} · {album}");
  await expect(page.locator(".discord-card-state")).toContainText("·");
  await page.getByRole("textbox", { name: "Line 3" }).fill("");
  await expect(page.locator(".discord-card-line")).toHaveCount(1);
  // Typing saves once it pauses, sending only the options that changed.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { desktopConfig: DesktopConfig }).desktopConfig.discordCard))
    .toEqual({ ...config.discordCard, state: "{artist} · {album}", largeText: "" });
  const sent = await page.evaluate(() =>
    (window as unknown as { desktopSaves: DesktopConfigPatch[] }).desktopSaves.flatMap((save) => Object.keys(save.discordCard ?? {})),
  );
  expect(new Set(sent)).toEqual(new Set(["state", "largeText"]));
});

test("the side column shuts when the Discord options go", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1100, "Only wide windows have the side column.");
  await openSection(page, "Discord");
  const dialog = page.locator(".settings");
  await expect(dialog).not.toHaveAttribute("data-side");
  await page.getByRole("button", { name: "Show preview" }).click();
  await expect(dialog).toHaveAttribute("data-side", "true");
  await page.locator(".settings-nav-item", { hasText: "Appearance" }).click();
  await expect(dialog).not.toHaveAttribute("data-side");
  await expect(page.getByRole("button", { name: /preview/ })).toHaveCount(0);
  // Coming back, it's open as it was left.
  await page.locator(".settings-nav-item", { hasText: "Discord" }).click();
  await expect(dialog).toHaveAttribute("data-side", "true");
  // Turning the status off takes the card options, and the column, away.
  await page.getByRole("switch", { name: "Discord status" }).click();
  await expect(dialog).not.toHaveAttribute("data-side");
  await expect(page.locator(".discord-popout")).toHaveCount(0);
});

test("a search that finds the card options offers the preview too", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1100, "Only wide windows have the side column.");
  await openSection(page, "Appearance");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("preview");
  await expect(page.locator(".settings-heading")).toHaveText("Search results");
  const dialog = page.locator(".settings");
  await expect(dialog).not.toHaveAttribute("data-side");
  await page.getByRole("button", { name: "Show preview" }).click();
  await expect(dialog).toHaveAttribute("data-side", "true");
  await expect(page.locator(".settings-side .discord-popout")).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide preview" })).toHaveAttribute("aria-expanded", "true");
});

test("now playing api settings", async ({ page }, testInfo) => {
  await openSection(page, "Connections");
  const address = page.getByRole("textbox", { name: "Now playing API address" });
  await expect(address).toHaveCount(0);
  await page.getByRole("switch", { name: "Now playing API" }).click();
  await expect(address).toHaveValue("http://127.0.0.1:48638/now-playing?token=first-token-0123456789");
  await page.getByRole("button", { name: "New token" }).click();
  await expect(address).toHaveValue("http://127.0.0.1:48638/now-playing?token=second-token-0123456789");
  await settle(page);
  await checkUI(page, testInfo, {
    exceptions: [
      ...desktopExceptions,
      {
        selector: ".settings-nav-item",
        rules: ["icon-button-tooltip"],
        reason: "On phones the sections are a strip that scrolls sideways. With Connections picked, the next section sits past the strip's edge, so its label is clipped rather than missing.",
      },
    ],
  });
});

// The suite runs with reduced motion. The closed state lists its own
// transitions (so a width change while closed snaps); that rule must not
// outrank reduced motion and bring the closing fade back.
test("settings close at once with reduced motion", async ({ page }) => {
  await openSection(page, "Discord");
  await ready(page, page.locator(".discord-popout"));
  const closing = await page.evaluate(async () => {
    const dialog = document.querySelector<HTMLElement>(".settings")!;
    const open = getComputedStyle(dialog).transitionProperty;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    for (let frame = 0; frame < 30 && !dialog.closest("[data-closed]"); frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const style = getComputedStyle(dialog);
    return { open, closed: !!dialog.closest("[data-closed]"), transition: style.transitionProperty, opacity: style.opacity };
  });
  expect(closing).toEqual({ open: "none", closed: true, transition: "none", opacity: "0" });
});
