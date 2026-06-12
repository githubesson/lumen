import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: "@music-library/core/api",
        replacement: "../core/src/api.ts",
      },
      {
        find: "@music-library/core/events",
        replacement: "../core/src/events.ts",
      },
      {
        find: /^@music-library\/core$/,
        replacement: "../core/src/index.ts",
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
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
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
