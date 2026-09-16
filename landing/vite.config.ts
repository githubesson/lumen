import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

// GitHub Pages serves project sites under /<repo>/, so that is the default.
// A custom domain overrides both at build time:
//   LANDING_BASE=/ LANDING_SITE_URL=https://lumen.example npm run build
const base = process.env.LANDING_BASE ?? "/lumen/";
const siteUrl = (process.env.LANDING_SITE_URL ?? "https://githubesson.github.io/lumen").replace(/\/$/, "");

// Open Graph and canonical URLs must be absolute, which Vite's `base` cannot
// express. Substitute a single %SITE_URL% token in index.html instead.
function siteUrlPlugin(): Plugin {
  return {
    name: "lumen-site-url",
    transformIndexHtml(html) {
      return html.replaceAll("%SITE_URL%", siteUrl);
    },
  };
}

export default defineConfig({
  base,
  plugins: [solid(), tailwindcss(), siteUrlPlugin()],
  server: { port: 5174 },
  build: { outDir: "dist", target: "es2022" },
});
