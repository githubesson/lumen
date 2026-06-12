# frontend

React + Vite + TypeScript web client for Lumen, also packaged as a Windows
desktop app via Electron.

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
  can override it at runtime), FH6 radio page

Styling is Tailwind CSS v4 (via the Vite plugin). Shared logic (API client,
player state, auth, favorites) comes from
[`@music-library/core`](../core/) — aliased to `../core/src` in
`vite.config.ts` and `tsconfig.json`, so changes to core are picked up live.

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

## Electron (desktop)

```sh
npm run electron:compile   # compile main/preload
npm run electron:dev       # build web + run Electron locally
npm run electron:build     # package Windows portable + NSIS installer
```

Packaging config is [electron-builder.yml](./electron-builder.yml). Note its
`extraResources` block pulls an optional FH6-radio bridge (a game-mod DLL)
from an untracked `_local/` folder — it is not part of this repo. Remove that
block if you don't have it.

## Docker

The [Dockerfile](./Dockerfile) builds the app and serves `dist/` with nginx
(config in [nginx.conf](./nginx.conf)). The build context is the **repo
root**, because the image needs both `frontend/` and `core/`:

```sh
docker build -f frontend/Dockerfile .
```

The deployment compose at the repo root does this for you.
