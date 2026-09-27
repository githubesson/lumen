# frontend

React + Vite + TypeScript web client for Lumen, also packaged as a Windows,
macOS, and Linux desktop app via Electron.

## Features

- Library browser, search, album/artist views, persistent player with queue
  and scrubbing
- Playlists (create, edit, local sort), favorites, recently played, and a
  yearly **Replay** summary
- Share previews for tracks/albums/playlists
- Admin pages: invites (create / list / revoke with copyable one-time
  registration links) and library/music-root management
- Login, invite-link registration, forced password reset flows
- Desktop build extras: Discord Rich Presence (off by default — create an
  application at
  [discord.com/developers](https://discord.com/developers/applications) and
  put its ID in `.env`, copied from [.env.example](./.env.example); the
  build step bakes it into the packaged app, and the app's `config.json`
  can override it at runtime), automatic desktop updates, FH6 radio page

Styling is Tailwind CSS v4 (via the Vite plugin). Shared logic (API client,
player state, auth, favorites) comes from
[`@music-library/core`](../core/) — aliased to `../core/src` in
`vite.config.ts` and `tsconfig.json`, so changes to core are picked up live.

## Component inventory

Reusable UI lives under `src/components/`:

- **Layout / chrome**: `PageHeader`, `ListPageHeader`, `Section`,
  `CenteredCard`, `Shell`, `DialogShell`, `DialogFooter`
- **Form primitives**: `Button`, `Field`, `TextInput`, `Select`,
  `SearchInput`, `SegmentedControl`, `RadioCardOption`, `Fieldset`
- **Data display**: `TrackList`, `MediaCard`, `PlaylistCard`, `StatCard`,
  `EmptyState`, `LoadingState`, `ErrorBanner`, `DataState`
- **Track-specific**: `TrackCheckbox`, `TrackSelectionToolbar`,
  `TrackContextMenu`
- **Admin helpers**: `admin/AdminPanel`, `admin/AdminSection`
- **Library helpers**: `library/BrowseToolbar`

Shared hooks are in `src/lib/`:

- `useTrackSelection` — selection mode, range selection, select-all, and
  export lifecycle for track tables (used by `TrackList` and playlist
  detail).

## Develop

```sh
npm install
npm run dev        # http://localhost:5173
```

The dev server proxies `/api`, `/share`, and `/embed` to
`http://localhost:8080` — run the [backend](../backend/) alongside with
`COOKIE_SECURE=false` so session cookies survive plain HTTP.

```sh
npm run typecheck
npm run build      # emits dist/
```

### Lint

Run `npm run lint` from `frontend/`, or `npm --prefix frontend run lint`
from the repository root. CI runs the same command.

[`eslint.config.js`](./eslint.config.js) registers `@shadcn/lint` for
frontend source files alongside the existing ESLint rules. Relative imports
into `src/components/` are configured for component recognition; the plugin
automatically discovers the Tailwind theme in `src/index.css`.

The plugin requires Node.js 20.19+ and ESLint 9.30+.

#### Design-system rules

The following checks run as errors through the existing lint command and CI:

| Rule | Lumen policy |
| --- | --- |
| `no-raw-colors` | Use theme colors instead of Tailwind palette colors or literal SVG colors. |
| `no-unknown-classes` | Classes must exist in Tailwind or the CSS imported by `src/index.css`. |
| `no-restyle` | Consumers may place and size components with layout classes; appearance belongs in the component. |
| `no-arbitrary-values` | Consumers use theme variables and scale values for appearance; arbitrary layout values are allowed. |
| `require-static-classes` | Component consumers must provide classes the linter can read. |

Use `Button`'s `variant` and `size` props for its appearance. Existing named
CSS treatments (such as `card-art` on `CoverArt` and `playlist-search` on
`SearchInput`) have explicit component contracts in `eslint.config.js`.
Keep new exceptions specific to the component and an existing CSS class.

Component implementations in `src/components/` are exempt from `no-restyle`,
`no-arbitrary-values`, and `require-static-classes` so they can define their
appearance and forward class props. Color and class-existence checks still
apply there.

Use CSS variable shorthand such as `text-(--fg-subtle)` for Lumen's theme
variables. `no-inline-styles` remains off because inline styles, including
dynamic dimensions and colors, are part of the existing component APIs.
Inline styles and plain CSS declarations are therefore outside these checks;
a passing lint run does not enforce every styling path.

After UI changes, run lint and fix violations. Review new tokens, component
contracts, and suppression comments as design decisions. See the
[available rules](https://github.com/shadcn-ui/lint#rules) and
[configuration examples](https://github.com/shadcn-ui/lint/blob/main/docs/design-systems.md)
when updating the policy.

## Electron (desktop)

```sh
npm run electron:compile             # compile main/preload
npm run electron:dev                 # build web + run Electron locally
npm run electron:build               # package Windows portable + NSIS installer
npm run electron:build:linux         # package Linux AppImage + deb
npm run electron:build:mac           # package a DMG for this Mac's architecture
npm run electron:build:mac:universal # package the universal DMG (release artifact)
```

Packaging config is [electron-builder.cjs](./electron-builder.cjs). It
bundles an optional FH6-radio bridge (a game-mod DLL) from an untracked
`_local/` folder when that folder exists, and skips it otherwise — no config
edits needed either way.

Icon files (`icon.ico`/`icon.icns`/`icon.png`/`Assets.car`) and the DMG
background are committed, so packaging never regenerates them. After changing
the app icon run `npm run icons` (needs Xcode 26 on macOS for the appearance
variants); after changing the DMG layout run `npm run dmg:background`.

On macOS, if `CSC_NAME` and `APPLE_KEYCHAIN_PROFILE` are set the build also
signs, notarizes, and staples the DMG container automatically (see
[AGENTS.md](./AGENTS.md) for the one-time credential setup). Without them you
get an unsigned dev build.

GitHub releases intentionally build unsigned binaries for all three desktop
platforms. Dispatch the release workflow from the branch you want to ship:

| Branch | Version | Release |
| --- | --- | --- |
| `main` | `0.1.4` | stable, `latest` update channel |
| `dev` | `0.1.4-dev.57` | prerelease, `dev` update channel |
| anything else | `0.1.4-branch-<name>.57` | prerelease that no updater follows |

Patch versions count up from the highest stable tag, and the number after the
branch name is the workflow run. To start a new minor or major line, raise
`version` in `package.json`. A pushed `v*` tag builds as exactly that version.
Each release is a draft until every platform has uploaded. Windows may show an unknown-publisher warning and macOS may require
the user to explicitly approve the app in Gatekeeper.

### Desktop updates

Packaged desktop builds check for updates shortly after launch and every six
hours. A found update is offered in a card in the corner of the main pane (and
under Updates in Settings): the user downloads it, then chooses **Restart &
install** or lets it install on quit. The Updates section in the tweaks
panel lets users choose one of two strictly whitelisted release streams:

- `main` follows stable GitHub Releases and reads `latest*.yml` metadata.
- `dev` follows prereleases built from the `dev` branch and reads `dev*.yml`
  metadata.

Dev builds default to `dev`; stable builds default to `main`. Users may switch
between them and may override the public GitHub repository URL, which must be
an `https://github.com/owner/repo` URL. `UPDATE_REPO_URL` is baked into the app
by `electron:compile` just like `DISCORD_CLIENT_ID`; it defaults to this
repository and can be set in `.env` locally or as a GitHub Actions repository
variable.

Auto-update works for installed Windows NSIS builds and supported Linux
packages. It is unavailable in the Windows portable build. macOS auto-update
requires a signed app and ZIP update artifact; the ZIP is produced by the
release workflow, but the intentionally unsigned CI builds cannot auto-update
until signing is configured.

## Docker

The [Dockerfile](./Dockerfile) builds the app and serves `dist/` with nginx
(config in [nginx.conf](./nginx.conf)). The build context is the **repo
root**, because the image needs both `frontend/` and `core/`:

```sh
docker build -f frontend/Dockerfile .
```

The deployment compose at the repo root does this for you.
