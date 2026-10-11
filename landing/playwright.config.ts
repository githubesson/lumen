import { readFileSync } from "node:fs";
import { defineConfig } from "playwright/test";

// `npm run lint:ui` checks the built site (run `npm run build` first) against
// ui-policy.json with lintapple, once per policy viewport and color scheme.
const policy = JSON.parse(readFileSync(new URL("./ui-policy.json", import.meta.url), "utf8")) as {
  viewports: { width: number; height: number }[];
  colorSchemes: ("light" | "dark")[];
};
const port = 4317;

export default defineConfig({
  testDir: "tests",
  testMatch: "*.ui.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: policy.viewports.flatMap((viewport) =>
    policy.colorSchemes.map((colorScheme) => ({
      name: `${viewport.width}px ${colorScheme}`,
      use: { viewport, colorScheme },
    })),
  ),
  webServer: {
    command: `npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
