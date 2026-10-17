import { expect, test, type Page } from "playwright/test";
import type { DesktopConfig, DesktopConfigPatch } from "../../src/contracts/desktop";
import { checkUI, ready, settle, signedIn } from "./helpers";

// Settings sections only the desktop app has. A stand-in for the Electron
// bridge serves the desktop config and records what Settings saves.
const config: DesktopConfig = {
  backendUrl: "https://music.example.com",
  discordEnabled: true,
  alwaysOnTop: false,
  fh6RadioEnabled: false,
  fh6GameDir: "",
  fh6BridgePort: 8787,
  discordCard: {
    details: "{title}",
    state: "{artist}",
    largeText: "{album}",
    statusName: "app",
    cover: true,
    playState: true,
    showPaused: true,
  },
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
        return { ok: true, config: { ...config }, changed: false };
      },
      getSignOutIntent: async () => false,
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
  // With room beside the dialog the preview opens a side column, so it stays
  // in view while the options scroll; otherwise it heads the section.
  const side = (page.viewportSize()?.width ?? 0) >= 1100;
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
  await expect(dialog).toHaveAttribute("data-side", "true");
  await page.locator(".settings-nav-item", { hasText: "Appearance" }).click();
  await expect(dialog).not.toHaveAttribute("data-side");
  await page.locator(".settings-nav-item", { hasText: "Discord" }).click();
  await expect(dialog).toHaveAttribute("data-side", "true");
  // Turning the status off takes the card options, and the column, away.
  await page.getByRole("switch", { name: "Discord status" }).click();
  await expect(dialog).not.toHaveAttribute("data-side");
  await expect(page.locator(".discord-popout")).toHaveCount(0);
});
