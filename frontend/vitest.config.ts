import { defineConfig } from "vitest/config";

export default defineConfig({
  // Core is consumed as source; its React 19 dev dependency must not become a
  // second React copy when testing frontend providers with React 18.
  resolve: { dedupe: ["react", "react-dom"] },
  test: { environment: "jsdom", include: ["tests/**/*.test.ts?(x)"] },
});
