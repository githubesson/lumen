import { readFileSync } from "node:fs";
import { defineConfig } from "playwright/test";

// `npm run lint:ui` checks the built site (run `npm run build` first) against
// ui-policy.json with lintapple, once per policy viewport and color scheme.
const policy = JSON.parse(readFileSync(new URL("./ui-policy.json", import.meta.url), "utf8")) as {
  viewports: { width: number; height: number }[];
  colorSchemes: ("light" | "dark")[];
};
// Off the common dev and OpenTelemetry ports, since a local server on this
// port is reused.
const port = 4781;
// The build's sub-path, which vite.config.ts also reads (see README).
const url = `http://localhost:${port}${process.env.LANDING_BASE ?? "/"}`;

export default defineConfig({
  testDir: "tests",
  testMatch: "*.ui.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // CI starts cold: allow for the first page loads and one retry.
  retries: process.env.CI ? 1 : 0,
  timeout: process.env.CI ? 60_000 : 30_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: url,
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
    url,
    reuseExistingServer: !process.env.CI,
  },
});
