import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// LANDING_BASE lets the site live under a sub-path (e.g. GitHub Pages at
// /lumen/) without touching the source.
export default defineConfig({
  base: process.env.LANDING_BASE ?? "/",
  plugins: [react(), tailwindcss()],
});
