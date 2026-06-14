# Tracker API Reference

A read-mostly HTTP/JSON API over a catalog of TrackerHub-style spreadsheets
(community song trackers). A Go service scrapes and normalizes the source
spreadsheets into Postgres; this API exposes the normalized catalog plus a small
admin surface for triggering refreshes.

This document is implementation-complete: every endpoint, query parameter,
response shape, status code, and behavior needed to reimplement the API on
another stack is described below.

---

## Base URL & ports

The service mounts everything under `/api`. There is no path rewriting in front
of it — the upstream sees the full `/api/...` path.

| How you reach it | URL |
| --- | --- |
| **Production** | `https://trackers.musicfiles.su/api` |
| Through the bundled Nginx (`backend/nginx/tracker.conf`, listens on `:80`) | `http://your-host/api` |
| Directly against the Go service in Docker Compose | `http://127.0.0.1:4444/api` |

The production deployment is served at `trackers.musicfiles.su`; call the API at
`https://trackers.musicfiles.su/api/...` (e.g.
`https://trackers.musicfiles.su/api/v1/trackers`).

The Go process binds `:$PORT`. The code default for `PORT` is `8080`; the
provided `docker-compose.yml` sets `PORT=4444` and publishes it on
`127.0.0.1:4444`. Nginx proxies `location /api/` to `127.0.0.1:4444` and
everything else to the frontend on `127.0.0.1:9191`.

All responses are sent with `Content-Type: application/json` (a single
middleware sets this for every route, including errors).

---

## Authentication

- **Read endpoints are public** — no header required.
- **Admin endpoints** require a bearer token:

  ```http
  Authorization: Bearer <ADMIN_API_KEY>
  ```

The expected value is compared exactly against the literal string
`Bearer ` + `ADMIN_API_KEY`. The default development key is `dev-admin-key`. If
`ADMIN_API_KEY` is empty, **all** admin requests are rejected (the endpoints
become unreachable, never open).

A missing or wrong token returns:

```http
HTTP/1.1 401 Unauthorized
```
```json
{ "error": "missing or invalid bearer token" }
```

Admin endpoints: `POST /api/v1/admin/refresh/global`,
`POST /api/v1/admin/refresh/trackers/{id}`, `GET /api/v1/admin/jobs`,
`GET /api/v1/admin/jobs/{id}`.

---

## Conventions

### Pagination envelope

List endpoints that paginate return:

```json
{
  "items": [],
  "limit": 50,
  "offset": 0,
  "total": 0
}
```

- `total` is the full count matching the filters (before `limit`/`offset`).
- `items` is the current page.

Two list endpoints are **not** truly paginated and return everything:
- `GET /api/v1/trackers/lookup` → `{ "items": [...] }` (no limit/offset/total).
- `GET /api/v1/trackers/{id}/sheets` → uses the envelope, but `limit` and
  `total` both equal the number of sheets and `offset` is always `0`.

### Pagination parameters

| Name | Type | Default | Rules |
| --- | --- | --- | --- |
| `limit` | integer | `50` | Values `<= 0` become `50`; values `> 500` are clamped to `500`. |
| `offset` | integer | `0` | Negative values become `0`. |

Non-numeric values parse as `0` and therefore fall back to the defaults.

### Filter parameter semantics

- `era`, `type`, `quality`, `q` — whitespace-trimmed, **case-insensitive
  partial match** (SQL `ILIKE '%value%'`).
- `q` matches against the entry's combined search text **and** the tracker name.
- `era` / `type` / `quality` match against that specific normalized field.
- `has_links` — parsed as a boolean. Accepted truthy/falsy values follow Go's
  `strconv.ParseBool`: `1, t, T, TRUE, true, True` and `0, f, F, FALSE, false,
  False`. `true` keeps only entries with at least one link; `false` keeps only
  entries with none. Any unparseable value is ignored (no filtering).
- `tracker_id` (search only) — parsed as an integer; only applied when `> 0`.

### Error shape

Every error returns the same body:

```json
{ "error": "human-readable message" }
```

| Status | When |
| --- | --- |
| `400 Bad Request` | Path `{id}` is missing, non-numeric, or `<= 0` (`{"error":"invalid id"}`). |
| `401 Unauthorized` | Admin route without a valid bearer token. |
| `404 Not Found` | `GET /trackers/{id}` or `GET /admin/jobs/{id}` for an id that does not exist. |
| `500 Internal Server Error` | Unexpected database/query failure. |
| `503 Service Unavailable` | `GET /api/ready` when the database is unreachable. |

### HTTP methods

Routes are method-specific. Health is `GET`; reads are `GET`; admin refresh
triggers are `POST`. Any other method on a known path yields the standard
`405`/`404` from the Go router.

---

## Data models

These are the JSON shapes returned by the API. `omitempty` means the field is
absent from the response when empty/zero/null.

### Tracker

One row of the TrackerHub master index plus derived metadata.

```json
{
  "id": 1,
  "row": 4,
  "tracker_name": "50 Cent",
  "tracker_name_raw": "⭐ 50 Cent",
  "flags": ["best_of"],
  "credits": "Example",
  "credit_url": "",
  "up_to_date": "Yes",
  "working_links": "Yes",
  "url": "https://docs.google.com/spreadsheets/d/.../edit?gid=...",
  "original_url": "https://docs.google.com/spreadsheets/d/.../edit?gid=...",
  "resource_type": "spreadsheet",
  "resource_id": "...",
  "spreadsheet_id": "...",
  "gid": "...",
  "duplicate_of_row": null,
  "entry_count": 471,
  "image_data_uri": "data:image/jpeg;base64,..."
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | integer | Internal database ID. Stable; use this for sub-resources. |
| `row` | integer | Row number on the TrackerHub master sheet. |
| `tracker_name` | string | Cleaned display name. |
| `tracker_name_raw` | string | Original cell text (may include emoji/markers). |
| `flags` | string[] | Derived flags, e.g. `best_of`. May be empty. |
| `credits` | string | Credit text from the index. |
| `credit_url` | string | Credit link, if any. |
| `up_to_date` | string | Free-text status from the index (e.g. `Yes`). |
| `working_links` | string | Free-text status from the index. |
| `url` | string | Resolved spreadsheet URL. |
| `original_url` | string | URL as written in the index. |
| `resource_type` | string | e.g. `spreadsheet`. |
| `resource_id` | string | Google resource ID. |
| `spreadsheet_id` | string | Google spreadsheet ID. |
| `gid` | string | Sheet gid within the spreadsheet. |
| `duplicate_of_row` | integer \| null | Set when this row duplicates another. |
| `entry_count` | integer | Parsed entries for this tracker. |
| `image_data_uri` | string | `omitempty`. Base64 `data:` URI of the resolved artist image; present only when an image was fetched. Can be large. |

> The `lookup` endpoint returns a leaner shape — see [Tracker lookup item](#tracker-lookup-item).

### Tracker lookup item

Lean shape for typeahead / command-palette UIs. Never includes image bytes.

```json
{
  "id": 1,
  "tracker_name": "50 Cent",
  "entry_count": 471,
  "has_image": true
}
```

### Sheet

A parsed tab within a tracker's spreadsheet.

```json
{
  "id": 10,
  "tracker_id": 1,
  "name": "gid-1520634709",
  "header_row": 1,
  "columns": ["Era", "Name", "Notes"],
  "entry_count": 471
}
```

### Entry

A single normalized row from a tracker sheet. The labeled fields below are typed
as "any" because they are parsed from JSON cells and may be a string, number,
boolean, null, or nested object depending on the source.

```json
{
  "id": 100,
  "tracker_id": 1,
  "tracker_name": "50 Cent",
  "tracker_url": "https://docs.google.com/spreadsheets/d/...",
  "sheet_id": 10,
  "sheet_name": "gid-1520634709",
  "row_number": 3,
  "era": "Before Power Of The Dollar",
  "rec_era": "1999",
  "rel_era": null,
  "name": "Song name",
  "notes": "Notes",
  "length": "3:12",
  "file_date": "2024-01-01",
  "leak_date": "2024-02-01",
  "type": "Demo",
  "portion": "Full",
  "quality": "CD Quality",
  "links": ["https://example.com/file"],
  "raw": {
    "Era": "Before Power Of The Dollar",
    "Name": "Song name"
  },
  "fields": {
    "era": "Before Power Of The Dollar",
    "name": "Song name",
    "row_number": 3
  },
  "less_common_fields": {
    "producer": "Producer name"
  }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | integer | Internal entry ID. |
| `tracker_id` | integer | Owning tracker. |
| `tracker_name` | string | `omitempty`. Joined from the tracker. |
| `tracker_url` | string | `omitempty`. Joined from the tracker. |
| `sheet_id` | integer | Owning sheet. |
| `sheet_name` | string | Sheet name. |
| `row_number` | integer | Row index within the sheet. |
| `era`, `rec_era`, `rel_era` | any | `omitempty`. Era / recording era / release era. |
| `name`, `notes`, `length` | any | `omitempty`. |
| `file_date`, `leak_date` | any | `omitempty`. |
| `type`, `portion`, `quality` | any | `omitempty`. |
| `links` | string[] | Always present; may be `[]`. |
| `raw` | object | Original row keyed by the sheet's column headers. |
| `fields` | object | Normalized field map (snake_case keys). |
| `less_common_fields` | object | `omitempty`. Entries from `fields` whose keys are **not** one of the canonical fields (`era, rec_era, rel_era, name, notes, length, file_date, leak_date, type, portion, quality, links, raw, row_number`). Lets clients surface tracker-specific extra columns. |

### Job

A refresh job (global or single-tracker).

```json
{
  "id": 1,
  "scope": "tracker",
  "tracker_id": 42,
  "status": "failed",
  "error": "download failed with HTTP 403",
  "requested_at": "2026-05-11T12:00:00Z",
  "started_at": "2026-05-11T12:00:01Z",
  "finished_at": "2026-05-11T12:00:03Z"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | integer | Job ID. |
| `scope` | string | `global` or `tracker`. |
| `tracker_id` | integer \| null | `null` for global jobs. |
| `status` | string | See status table below. |
| `error` | string | `omitempty`. Present only on failure. |
| `requested_at` | RFC 3339 timestamp | When the job was enqueued. |
| `started_at` | RFC 3339 timestamp | `omitempty`. When it began running. |
| `finished_at` | RFC 3339 timestamp | `omitempty`. When it ended. |

Job statuses:

| Status | Meaning |
| --- | --- |
| `queued` | Waiting to run. |
| `running` | Currently executing. |
| `succeeded` | Finished successfully. |
| `failed` | Finished with an error (see `error`). |

---

## Endpoints

### Health

#### `GET /api/health`

Process liveness. Always `200` if the process is up.

```json
{ "status": "ok" }
```

#### `GET /api/ready`

Readiness — pings the database.

- `200`: `{ "status": "ready" }`
- `503`: `{ "error": "<db error>" }`

---

### Trackers

#### `GET /api/v1/trackers`

Paginated list of trackers, ordered by `row` (TrackerHub master-sheet order).

Query parameters: `limit`, `offset` (see [Pagination parameters](#pagination-parameters)).

Returns a [pagination envelope](#pagination-envelope) of [Tracker](#tracker) items.

#### `GET /api/v1/trackers/lookup`

All trackers in the lean lookup shape, ordered by `row`. **Not paginated.**

```json
{
  "items": [
    { "id": 1, "tracker_name": "50 Cent", "entry_count": 471, "has_image": true }
  ]
}
```

> Routing note: `/trackers/lookup` is a distinct, more-specific route than
> `/trackers/{id}`, so `lookup` is never treated as an id.

#### `GET /api/v1/trackers/{id}`

A single [Tracker](#tracker) by internal database ID.

- `200`: the tracker object.
- `400`: id not a positive integer.
- `404`: no tracker with that id.

#### `GET /api/v1/trackers/{id}/sheets`

All [Sheet](#sheet) rows for a tracker, ordered by sheet ID. Returns the
envelope, but it is not really paginated:

```json
{
  "items": [ /* Sheet objects */ ],
  "limit": 2,
  "offset": 0,
  "total": 2
}
```

`limit` and `total` both equal the number of sheets returned.

#### `GET /api/v1/trackers/{id}/entries`

Paginated [Entry](#entry) list for one tracker, ordered by
`(tracker row, sheet id, row number)`.

Query parameters:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `era` | string | none | Case-insensitive partial match. |
| `type` | string | none | Case-insensitive partial match. |
| `quality` | string | none | Case-insensitive partial match. |
| `has_links` | boolean | none | Filter to entries with / without links. |
| `limit` | integer | `50` | Max `500`. |
| `offset` | integer | `0` | Pagination offset. |

Returns a [pagination envelope](#pagination-envelope) of [Entry](#entry) items.
(The `q` and `tracker_id` parameters are **not** read here — the tracker is taken
from the path. Use `/search` for full-text or cross-tracker queries.)

---

### Search

#### `GET /api/v1/search`

Search/normalize entries across all trackers. Same response shape and ordering
as the per-tracker entries endpoint.

Query parameters:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `q` | string | none | Case-insensitive match across entry search text **and** tracker name. |
| `tracker_id` | integer | none | Restrict to one tracker (applied only when `> 0`). |
| `era` | string | none | Case-insensitive partial match. |
| `type` | string | none | Case-insensitive partial match. |
| `quality` | string | none | Case-insensitive partial match. |
| `has_links` | boolean | none | Filter to entries with / without links. |
| `limit` | integer | `50` | Max `500`. |
| `offset` | integer | `0` | Pagination offset. |

All filters combine with AND. Returns a [pagination envelope](#pagination-envelope)
of [Entry](#entry) items.

Example:

```text
GET /api/v1/search?q=demo&quality=CD&has_links=true&limit=25
```

---

### Stats

#### `GET /api/v1/stats`

Catalog-wide counts.

```json
{
  "trackers": 523,
  "sheets": 500,
  "entries": 10000,
  "parse_errors": 12
}
```

`parse_errors` is the number of recorded parse failures (see
[Refresh & parsing behavior](#refresh--parsing-behavior)).

---

### Admin — Refresh

Both require admin auth and respond with **`202 Accepted`** and a [Job](#job).

Enqueue is **idempotent per scope**: if a `queued` or `running` job already
exists for the same scope (and same tracker, for tracker scope), that existing
job is returned instead of creating a duplicate.

#### `POST /api/v1/admin/refresh/global`

Queues (or returns the in-flight) global refresh of the whole TrackerHub index.

```json
{
  "id": 1,
  "scope": "global",
  "tracker_id": null,
  "status": "queued",
  "requested_at": "2026-05-11T12:00:00Z"
}
```

#### `POST /api/v1/admin/refresh/trackers/{id}`

Queues (or returns the in-flight) refresh for a single tracker.

- `202`: the job.
- `400`: id not a positive integer.

---

### Admin — Jobs

Both require admin auth.

#### `GET /api/v1/admin/jobs`

Paginated [Job](#job) list, newest first (ordered by descending ID).

Query parameters: `limit`, `offset`. Returns a [pagination envelope](#pagination-envelope).

#### `GET /api/v1/admin/jobs/{id}`

A single [Job](#job).

- `200`: the job.
- `400`: id not a positive integer.
- `404`: no job with that id.

---

## Refresh & parsing behavior

Background behavior a reimplementation should reproduce:

- **First boot.** On startup, after running database migrations, if the catalog
  is empty a global refresh is enqueued automatically.
- **Scheduled refresh.** A global refresh is enqueued every `REFRESH_INTERVAL`
  (default `1h`).
- **Worker.** A background worker claims `queued` jobs one at a time (FIFO by ID,
  using `FOR UPDATE SKIP LOCKED`), marks them `running` with `started_at`, then
  `succeeded` / `failed` with `finished_at`.
- **Concurrency.** A global refresh fetches and parses individual tracker
  spreadsheets concurrently, with `REFRESH_WORKERS` workers (default `8`).
- **Failure handling.** Per-tracker parse failures are recorded in the
  `parse_errors` table and surfaced via `/stats`. A global refresh continues past
  individual tracker failures unless `FAIL_FAST_REFRESH=true`.

---

## Configuration

Environment variables read by the Go service:

| Variable | Default (code) | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://tracker:tracker@postgres:5432/tracker?sslmode=disable` | Postgres connection string. |
| `ADMIN_API_KEY` | `dev-admin-key` | Bearer token for admin endpoints. Empty disables admin access entirely. |
| `PORT` | `8080` | HTTP listen port. (`docker-compose.yml` sets `4444`.) |
| `TRACKERHUB_URL` | TrackerHub master spreadsheet URL | Source index to scrape. |
| `REFRESH_INTERVAL` | `1h` | Global refresh cadence. Accepts a Go duration (`30m`, `2h`) or a plain integer (seconds). |
| `REQUEST_TIMEOUT` | `60s` | Outbound fetch timeout. |
| `REFRESH_WORKERS` | `8` | Concurrent per-tracker fetch/parse workers (minimum `1`). |
| `FAIL_FAST_REFRESH` | `false` | If `true`, abort a refresh on the first tracker failure. |

---

## Quick reference

| Method | Path | Auth | Returns |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ status }` |
| GET | `/api/ready` | — | `{ status }` or `503` |
| GET | `/api/v1/trackers` | — | Page of Tracker |
| GET | `/api/v1/trackers/lookup` | — | `{ items: TrackerLookup[] }` |
| GET | `/api/v1/trackers/{id}` | — | Tracker |
| GET | `/api/v1/trackers/{id}/sheets` | — | Envelope of Sheet (all) |
| GET | `/api/v1/trackers/{id}/entries` | — | Page of Entry |
| GET | `/api/v1/search` | — | Page of Entry |
| GET | `/api/v1/stats` | — | `{ trackers, sheets, entries, parse_errors }` |
| POST | `/api/v1/admin/refresh/global` | Bearer | Job (`202`) |
| POST | `/api/v1/admin/refresh/trackers/{id}` | Bearer | Job (`202`) |
| GET | `/api/v1/admin/jobs` | Bearer | Page of Job |
| GET | `/api/v1/admin/jobs/{id}` | Bearer | Job |
