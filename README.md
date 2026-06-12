# Lumen

![Lumen showcase](docs/SHOWCASE.png)

Self-hosted, invite-only music library with web, desktop, and mobile clients.

Point it at folders of audio files; it scans and indexes them, then serves them
to every client — streaming with scrubbing, playlists, favorites, play history,
a yearly Replay, public share/embed links with link previews, and an admin
surface for invites and library management.

<details>
<summary><strong>Full feature list</strong></summary>

### Library & playback

- Multiple music roots, scanned and indexed with a filesystem watcher; manual rescan from the admin UI
- Metadata and cover-art extraction, album/artist/track browsing, search (with a command palette on web)
- Range-request audio streaming — instant scrubbing, no full-file buffering
- Optional ffmpeg transcoding behind a flag
- Persistent player with queue, mini player, and now-playing view
- Play history (recently played) and per-user play stats
- Uploads from the web and mobile apps
- Track and album metadata editing

### Playlists, favorites & Replay

- Playlists with create/edit, add-tracks flow, and local sorting (title, length, plays)
- Playlist collaborators — invite others to a shared playlist
- Favorites across all clients
- Yearly **Replay**: listening recap with activity chart, animated stats, and a shareable top-songs image

### Sharing

- Public share pages with Open Graph tags — links unfurl with cover, title, and a playable preview in Discord and chat apps
- Embeddable players advertised in the link-preview metadata
- Server-rendered preview images/videos for shares
- HMAC-signed cover/share/preview URLs — public links need no session, but can't be forged

### Accounts & admin

- Invite-only registration: admins mint tokens with role, max uses, and expiry; pending-invite overview
- Argon2id password hashing, HTTP-only cookie sessions, forced password reset for the seeded admin
- Admin surface: user management, music roots, library maintenance, and import pins

### Importers

- Pull new files into the library from external sources on a poll interval: Filen share links, ArtistGrid, Lastshare, and tracker-API pins with per-pin destination folders

### Desktop app (Electron, Windows)

- Portable build + NSIS installer
- Discord Rich Presence ("Listening to Lumen" with cover art)
- First-run server-setup window, always-on-top toggle, custom window controls
- Optional Forza Horizon 6 in-game radio bridge

### Mobile app (Expo, iOS / Android)

- Background playback with lock-screen / now-playing controls (custom native module)
- AirPlay output picker on iOS
- Instagram story sharing for Replay and tracks
- Full library, playlists (incl. collaborators), favorites, uploads, metadata editing, and admin screens on the go
- Liquid-glass UI with haptics, deep-link scheme for share links

</details>

## Components

| Directory | What it is |
| --- | --- |
| [`backend/`](backend/) | Go HTTP API — auth, invites, library scanning/ingest, streaming, playlists, sharing, previews, optional ffmpeg transcoding. Postgres-backed. |
| [`frontend/`](frontend/) | React + Vite + TypeScript web app, also packaged as a Windows desktop app via Electron. |
| [`mobile/`](mobile/) | Expo Router / React Native app for iOS and Android. |
| [`core/`](core/) | Shared TypeScript package (`@music-library/core`) — API client, player state, auth, favorites — consumed by the web and mobile clients. |

Deployment lives at the repo root: [docker-compose.yml](docker-compose.yml)
runs Postgres + backend + frontend, both app images built straight from this
repo.

## Run it

```sh
cp .env.example .env
# edit .env — at minimum set POSTGRES_PASSWORD and COVER_SIGN_KEY
docker compose up -d --build
```

That starts:

- **postgres** — Postgres 16, data in `./pgdata`, bound to `127.0.0.1:${POSTGRES_PORT}`
- **backend** — Go API on `127.0.0.1:${BACKEND_PORT}` (default 8080)
- **frontend** — SPA behind nginx on `127.0.0.1:${FRONTEND_PORT}` (default 8081)

Your music lives wherever `MUSIC_HOST_PATH` points (default `/mnt/music`).
It's bind-mounted into the backend at the **same path** as on the host, so
music roots added in the admin UI resolve identically inside the container.

On first run the backend seeds an `admin` user; if you didn't set
`ADMIN_PASSWORD` in `.env`, grab the generated one from:

```sh
docker compose logs backend | grep generated_password
```

The admin is forced to set a new password on first login. From the admin UI
you can add music roots and create invites — registration is invite-only.

Re-run `docker compose up -d --build` any time you pull new source.

## Putting it on the internet

Both app ports bind to loopback only — put a reverse proxy in front. Copy
[docs/nginx.conf.example](docs/nginx.conf.example) into your nginx config and
edit the hostname + TLS setup. It routes `/api/*`, `/share/*`, and `/embed/*`
to the backend port and everything else to the frontend port, with buffering
and timeouts tuned for audio streaming. Keep `TRUSTED_PROXIES=172.16.0.0/12`
in `.env` (default Docker bridge range) so the backend sees real client IPs.

Serving over HTTPS? Keep `COOKIE_SECURE=true`. Plain HTTP (local only)? Set
`COOKIE_SECURE=false`, or the browser drops the session cookie.

## Backups

Two artifacts matter — your music directory (`MUSIC_HOST_PATH`) and Postgres
(all metadata, users, playlists, play history):

```sh
docker compose exec postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB \
  | gzip > backup-$(date +%F).sql.gz

rsync -a /mnt/music/ backups-host:/path/to/music/
```

## Development

Each project is self-contained with its own README, but the usual loop is:

```sh
# 1. Postgres + backend
docker run --rm -e POSTGRES_PASSWORD=mlib -e POSTGRES_USER=mlib -e POSTGRES_DB=mlib -p 5432:5432 postgres:16
cd backend
DATABASE_URL=postgres://mlib:mlib@localhost:5432/mlib?sslmode=disable COOKIE_SECURE=false go run ./cmd/server

# 2. Web app (proxies /api to localhost:8080)
cd frontend
npm install
npm run dev

# 3. Mobile app
cd mobile
npm install   # postinstall syncs core/ into packages/
npm run start
```

Shared client logic lives in [`core/`](core/). The web app imports it directly
from source; the mobile app uses a synced copy under
`mobile/packages/music-library-core` — run `npm run sync:core` in `mobile/`
after changing core.

## Repository layout

```
docker-compose.yml   Postgres + backend + frontend
.env.example         all deployment knobs, copy to .env
docs/                nginx site-config example for host-level proxying
backend/             Go API server (own Dockerfile)
core/                shared TypeScript core package
frontend/            web + Electron client (Dockerfile builds with repo root as context)
mobile/              Expo app
```

Runtime data (`./pgdata`, `./transcode-cache`) is created next to the compose
file and gitignored.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) tests the backend
and frontend on every push/PR, and publishes Docker images to GHCR on pushes
to `main` and version tags.
