import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import corePackage from "../core/package.json";

// Resolve every public core entry from the checked-out source package. Using
// node_modules for only some subpaths can pick up an older installed manifest.
const coreAliases = Object.entries(corePackage.exports).map(([entry, target]) => {
  const specifier = entry === "."
    ? corePackage.name
    : `${corePackage.name}/${entry.slice(2)}`;
  const pattern = specifier
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("\\*", "(.*)");
  return {
    find: new RegExp(`^${pattern}$`),
    replacement: fileURLToPath(
      new URL(`../core/${target.replace("*", "$1")}`, import.meta.url),
    ),
  };
});

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Core is consumed as source via the aliases below, so bare `react`
    // imports inside ../core/src would otherwise resolve to core's own
    // react@19 devDependency — two React copies, null dispatcher, dead
    // renderer. Force everything onto this package's copy.
    dedupe: ["react", "react-dom"],
    alias: coreAliases,
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
