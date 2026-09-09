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

### Search types

`GET /api/search?q=radiohead&type=album` searches albums. `type` accepts
`all`, `track`, `album`, or `artist`; `song` and plural names are also accepted.
Omitting `type` preserves the original track-only behavior. The shared client
provides `api.search` / `api.searchPage` (default `all`) and keeps
`api.searchTracks` / `api.searchTracksPage` track-only for playlist pickers.

The response contains `tracks`, `albums`, and `artists` arrays (including empty
arrays for excluded types), `sources`, `next_offsets`, and optional `warnings`.
Local results respect the viewer's library visibility. Remote albums and
artists include `source: "tidal"`, `source_id`, a namespaced `id`, and optional
`cover_url`. Open them with `/api/tidal/albums/{source_id}` or
`/api/tidal/artists/{source_id}`. The artist endpoint returns top songs and
releases from the proxy's bounded artist aggregation.

`sources=local,tidal` is the default; either source can be selected alone.
`limit` is per source and type (default 25, maximum 50). `all` may therefore
return up to six times `limit`. A source failure leaves successful results in
the response and adds a warning; retry the search to retry failed sources.
Unconfigured TIDAL is skipped by default; an explicit TIDAL source request
returns a configuration warning.

`next_offsets` contains only streams that may have more results. Track streams
retain the `local` / `tidal` keys; album and artist streams use `local_album`,
`tidal_album`, `local_artist`, and `tidal_artist`. Continue with `streams` set to
exactly the returned keys and a `<key>_offset` parameter for each value:

```text
/api/search?q=radiohead&type=all&limit=25&streams=tidal,tidal_album&tidal_offset=25&tidal_album_offset=50
```

Keep the query, type, sources, and limit unchanged across pages. An empty
`next_offsets` means exhausted (`streams=` explicitly requests no streams).
The combined result count is never a per-stream offset. Legacy track-only
callers can still continue with only the returned `sources` and their
`local_offset` / `tidal_offset` values.

TIDAL album and artist search requires the updated bundled
`hifi-api/lumen_hifi.py` extension (`/lumen/search/albums` and
`/lumen/search/artists`). Restart the Compose `hifi-api` service when deploying
this change. These endpoints query full collections rather than capped top
hits, using the proxy's existing credential handling. Independently hosted
proxies need the same extension to support these search types.

### Remote playback queue sync

Web, desktop, and mobile players publish their actual queue order alongside
WebSocket `activity.update` messages. `devices.snapshot` includes the latest
queue for each connected device, so controllers can join playback already in
progress. Queue snapshots stay in memory for that connection and are cleared
when playback is cleared or the device disconnects; no database migration is
required.

Snapshots fit within the 64 KiB WebSocket message limit, including the activity
payload. They contain up to 50 tracks around the current track, plus the window
offset, full queue length, current index within the window, shuffle/repeat
settings, and a queue revision. The window advances with playback. The
`jump_to` command uses an absolute index, track ID, and queue revision to select
a track without replacing or reshuffling the target's queue. The target rejects
selections from an outdated queue. Queue sync requires an updated backend and
both clients; older clients can continue sending activity without a queue.
