import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const coreSource = (path: string) =>
  fileURLToPath(new URL(`../core/src/${path}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: "@music-library/core/api",
        replacement: coreSource("api.ts"),
      },
      {
        find: "@music-library/core/events",
        replacement: coreSource("events.ts"),
      },
      {
        find: /^@music-library\/core$/,
        replacement: coreSource("index.ts"),
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        ws: true,
        rewriteWsOrigin: true,
      },
      "/share": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/embed": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(
              id,
            )
          ) {
            return "vendor";
          }
        },
      },
    },
  },
});
