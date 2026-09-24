# Lumen landing page

Public marketing site for Lumen. React + Vite + Tailwind v4, styled with the
same shadcn "Nova" neutral tokens and Geist fonts as `frontend/`, plus the
violet from the app icon (`resources/icon.icon`) as the one brand hue.

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static output in dist/
npm run lint && npm run typecheck
npm run deploy     # build + wrangler deploy to Cloudflare Workers
```

Hosted on Cloudflare Workers as static assets (`wrangler.jsonc`), on the
`lumen.rocks` and `www.lumen.rocks` custom domains. `wrangler deploy` needs a
Cloudflare login (`wrangler login`, or `CLOUDFLARE_API_TOKEN` with Workers
Scripts and Workers Routes edit on the account/zone).

## Notes

- The hero shows real app screenshots inside vector device frames
  (`components/devices/`): a MacBook Pro, where the web window floats on a
  wallpaper under a macOS menu bar, and an iPhone. The originals live in
  `screenshots/` (lossless WebP, dark and light); `npm run screens` renders
  width variants into `src/assets/screens/` (gitignored, run automatically
  before `dev` and `build`) so the browser can pick one close to the display
  size. Keep the screenshots as HTML `<img>` over the SVG and away from
  scale/3D transforms, or small text breaks up. To refresh them, replace the
  files in `screenshots/`: desktop window 1280×820 (2560×1640 is sharper on
  retina), phone 1178×2560.
- Each feature card has a small demo in `components/features/`, using the
  made-up tracks in `lib/music.ts`. Demos only tick while on screen, and all
  motion respects `prefers-reduced-motion`.
- Star count and the newest release (prereleases included) come from the
  GitHub API at runtime (`lib/github.ts`). Every consumer renders without them.
- Set `LANDING_BASE` at build time to serve from a sub-path, e.g.
  `LANDING_BASE=/lumen/ npm run build` for GitHub Pages.
