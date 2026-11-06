// Reference screenshots of the Electron frontend for pixel comparison with
// the Rune port: the React app with the UI-lint API mocks and a stubbed
// desktop bridge (platform win32), at the Electron window's default size.
//
//   cd native/tools/reference && TMPDIR=~/.cache/pwtmp \
//     ../../../frontend/node_modules/.bin/playwright test [-g scene]
//
// Shots land in native/out/ref/<scene>-<scheme>.png.
import { defineConfig } from "playwright/test";

const port = Number(process.env.REF_PORT ?? 4792);

export default defineConfig({
  testDir: ".",
  testMatch: "*.ref.ts",
  fullyParallel: true,
  workers: 3,
  timeout: 60_000,
  reporter: "line",
  use: {
    baseURL: `http://localhost:${port}`,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 820 },
    deviceScaleFactor: 1,
    // Fractional glyph advances, as DirectWrite gives the Windows build;
    // Linux Chromium's default full hinting rounds them to whole pixels.
    // Playwright hides scrollbars by default; the desktop app shows its styled ones.
    launchOptions: {
      args: ["--font-render-hinting=none"],
      ignoreDefaultArgs: ["--hide-scrollbars"],
    },
  },
  projects: [
    { name: "dark", use: { colorScheme: "dark" } },
    { name: "light", use: { colorScheme: "light" } },
  ],
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    cwd: "../../../frontend",
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
  },
});
