# backend

Go HTTP API for Lumen, the self-hosted, invite-only music library.

## Features

- **Auth** — Argon2id password hashing, HTTP-only cookie sessions backed by
  Postgres, first-run admin seeding (`ADMIN_USERNAME` / `ADMIN_PASSWORD`; if
  the password is empty a random one is generated and logged, and the seeded
  admin must reset it on first login).
- **Invite-only registration** — admins mint invite tokens (role, max uses,
  expiry); users register via `/register?token=…`.
- **Library** — admin-managed music roots, filesystem scanning and ingest with
  a watcher + rescan support, metadata extraction, cover art, search.
- **Playback** — ranged audio streaming (scrub-friendly), play history/stats,
  cross-device activity over an authenticated WebSocket with REST/Postgres
  snapshot recovery and addressed remote-control commands (see
  [docs/playback-websocket.md](docs/playback-websocket.md)). Local streaming serves
  the original audio format; client-profile transcoding is not supported.
- **Playlists & favorites** — CRUD plus per-user state.
- **Sharing** — public `/share/…` link-preview pages (what Discord and chat
  apps scrape), `/embed/…` embeddable players, and server-rendered preview
  images (see `fonts/`). Share/cover URLs are HMAC-signed with
  `COVER_SIGN_KEY`.
- **Importers** — pollers that pull new files into the library from external
  sources: Filen share links (via the bundled Node helper in
  `filen-downloader/`), ArtistGrid, Lastshare, and a tracker-API pin scanner
  (see [docs/api-tracker.md](docs/api-tracker.md) for that API's reference).

## Layout

```
cmd/server/           entrypoint
internal/
  auth/               argon2id, session store, bootstrap admin seeder
  config/             env-driven config
  db/                 pgx pool + embedded migrations
  httpapi/            chi router, middleware, handlers
  ingest/             scanner, watcher, rescan
  library/            library metadata store
  playlists/          playlist store
  preview/            share/embed preview + image rendering
  storage/            storage interface + local FS implementation
  invites/ users/     invite + user stores
  filen/ artistgrid/  external importers
  lastshare/ apitracker/ pinscan/
  musicroots/         admin-managed scan roots
fonts/                fonts bundled for preview image rendering
filen-downloader/     Node 20 helper the Docker image bundles for Filen links
```

## Run (local)

Requires Go 1.23+ and a Postgres 16 instance:

```sh
docker run --rm -e POSTGRES_PASSWORD=mlib -e POSTGRES_USER=mlib -e POSTGRES_DB=mlib -p 5432:5432 postgres:16

DATABASE_URL=postgres://mlib:mlib@localhost:5432/mlib?sslmode=disable COOKIE_SECURE=false go run ./cmd/server
```

Migrations run automatically on boot. `COOKIE_SECURE=false` is needed over
plain HTTP so the session cookie isn't dropped. All knobs are listed in
[.env.example](./.env.example).

Configuration is validated strictly at startup: booleans must be accepted by
Go's `strconv.ParseBool`, durations must parse and be greater than zero, and
`TRUSTED_PROXIES` entries must be IP literals or CIDR ranges. Invalid values
stop startup with the variable name instead of silently falling back. Check
existing deployment environment files before upgrading.

## Test / lint

```sh
gofmt -l .
go vet ./...
go test ./...
```

## Docker

The [Dockerfile](./Dockerfile) builds a static binary and ships it on Alpine
with ffmpeg (previews and TIDAL remuxing), Node (Filen helper), and the preview fonts. The
deployment compose at the repo root builds it with `context: ./backend`.

### Track pagination

`GET /api/tracks` accepts `sort=recent|title|artist|album|duration` (default
`recent`). Sorting is applied to the full visible result set before `limit` and
`offset`, with a track-ID tie breaker.

`GET /api/search` returns `next_offsets`, an object containing the next offset
for each source that may have more results. Continue with only those `sources`
and their `local_offset` / `tidal_offset` values, keeping the query and page size
unchanged. An empty object means the search is exhausted. Each source can return
up to 50 tracks per request; the combined result count is not a source offset.
