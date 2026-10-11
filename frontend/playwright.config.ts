import { readFileSync } from "node:fs";
import { defineConfig } from "playwright/test";

// `npm run lint:ui` checks the web app's screens against ui-policy.json with
// lintapple, once per policy viewport and color scheme. It runs the Vite dev
// server; tests/ui/mock-api.ts stands in for the backend.
const policy = JSON.parse(readFileSync(new URL("./ui-policy.json", import.meta.url), "utf8")) as {
  viewports: { width: number; height: number }[];
  colorSchemes: ("light" | "dark")[];
};
// Off the common dev and OpenTelemetry ports, since a local server on this
// port is reused.
const port = 4782;

export default defineConfig({
  testDir: "tests/ui",
  testMatch: "*.ui.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // CI starts cold: allow for the first page loads and one retry.
  retries: process.env.CI ? 1 : 0,
  timeout: process.env.CI ? 60_000 : 30_000,
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
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
