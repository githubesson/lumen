# landing

Public landing page for Lumen, built with [SolidJS](https://www.solidjs.com/),
Vite, and Tailwind CSS v4. It is a single static page with no dependency on
the other packages; the design tokens, fonts, and showcase image are copied
from `frontend/` and `docs/` so it renders in the product's own look.

Deployed to GitHub Pages by
[.github/workflows/pages.yml](../.github/workflows/pages.yml) on every push
to `main` that touches this folder.

## Develop

```sh
npm install
npm run dev        # http://localhost:5174/lumen/
```

```sh
npm run typecheck
npm run lint       # eslint + eslint-plugin-solid
npm run build      # dist/
npm run preview    # serve dist/ locally
```

## Base path and site URL

GitHub Pages serves project sites under `/<repo>/`, so the Vite base defaults
to `/lumen/` and absolute URLs (canonical, Open Graph) default to
`https://githubesson.github.io/lumen`. Both come from `vite.config.ts` and can
be overridden at build time for a custom domain:

```sh
LANDING_BASE=/ LANDING_SITE_URL=https://lumen.example npm run build
```

For a custom domain on Pages, set those two variables in the workflow and add
a `public/CNAME` file containing the domain.

## Enabling Pages

One-time setup in the repository settings: **Pages → Build and deployment →
Source: GitHub Actions**. Until that is set, the `deploy` job fails with a
message saying Pages is not enabled. Setting the repository homepage to the
Pages URL is optional but makes the link show up on the GitHub repo header.

## Downloads

The download section calls the public GitHub releases API from the browser,
prefers the newest stable release, and falls back to the newest pre-release
while no stable tag exists. Assets are matched by the suffixes
electron-builder produces (`-universal.dmg`, `-setup.exe`, `-portable.exe`,
`.AppImage`, `.deb`). If the request fails or is rate-limited, the section
links to the releases page instead.

## Images

`public/` holds generated images that are committed so the Pages build never
needs `sharp`:

- `desktop-{dark,light}-{1280,800}` and `mobile-{dark,light}-{780,480}`
  (`.avif` and `.webp`) from the app screenshots in `assets/screens/`. The
  hero shows them inside `Macbook.tsx`, generated from
  `assets/macbook-pro-front.svg`, and `Iphone.tsx`, a Solid port of the
  Magic UI iPhone mockup, one screen per theme
- `og.jpg` (1200×630 crop of `docs/SHOWCASE.png`) for link previews
- `favicon.png` and `apple-touch-icon.png` from the desktop app icon

Regenerate after either source changes:

```sh
npm run images
```

## Structure

```
index.html            meta tags, theme bootstrap, %SITE_URL% placeholder
src/index.tsx         entry
src/App.tsx           page composition
src/components/       one file per section plus Button, Icons, Logo, ...
src/lib/releases.ts   GitHub releases lookup
src/lib/platform.ts   desktop OS detection for the download button
src/lib/theme.ts      light/dark toggle
src/styles/index.css  tokens copied from frontend/src/index.css + components
scripts/              image generation
```
