# Tracker API Spec

Base path: `/api`

When using the included system Nginx example, call the API through:

```text
http://your-host/api
```

When calling the Go service directly on the same machine:

```text
http://127.0.0.1:4444/api
```

## Auth

Read endpoints are public.

Admin endpoints require:

```http
Authorization: Bearer <ADMIN_API_KEY>
```

`ADMIN_API_KEY` has no default and must be set, or the server refuses to start.
For local development, set `DEV_MODE=true` to use the throwaway key
`dev-admin-key`; production requires a real, strong key.

## Common Responses

Paginated endpoints return:

```json
{
  "items": [],
  "limit": 50,
  "offset": 0,
  "total": 0
}
```

Errors return:

```json
{
  "error": "message"
}
```

## Health

### GET `/api/health`

Returns process liveness.

```json
{
  "status": "ok"
}
```

### GET `/api/ready`

Returns readiness. This checks database connectivity.

```json
{
  "status": "ready"
}
```

## Trackers

### GET `/api/v1/trackers`

Lists TrackerHub trackers.

Query parameters:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | integer | `50` | Max `500`. |
| `offset` | integer | `0` | Pagination offset. |

Response item:

```json
{
  "id": 1,
  "source_key": "spreadsheet:1AbC...:1520634709|50 cent",
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
  "parse_status": "ok",
  "last_parse_error": "",
  "last_parsed_at": "2026-06-11T12:00:00Z",
  "last_seen_at": "2026-06-11T12:00:00Z",
  "missing_from_hub": false
}
```

`source_key` is the tracker's stable identity (Google resource + name);
trackers are upserted on it, so `id` never gets reassigned to a different
artist when the hub sheet reorders rows. `row` is display order only.

`parse_status` is one of `never`, `ok`, `failed`, or `unsupported`. When
`failed`, `last_parse_error` says why and the stored entries may be stale.
`missing_from_hub` is `true` when the hub no longer lists the tracker.

### GET `/api/v1/trackers/{id}`

Returns one tracker by internal database ID.

### GET `/api/v1/trackers/{id}/sheets`

Lists parsed sheets for a tracker.

Response item:

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

### GET `/api/v1/trackers/{id}/entries`

Lists parsed entries for a tracker.

Query parameters:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `era` | string | none | Case-insensitive partial match. |
| `type` | string | none | Case-insensitive partial match. |
| `quality` | string | none | Case-insensitive partial match. |
| `has_links` | boolean | none | `true` for entries with links, `false` for entries without links. |
| `limit` | integer | `50` | Max `500`. |
| `offset` | integer | `0` | Pagination offset. |

Response item:

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

### GET `/api/v1/trackers/{id}/eras`

Era/album artwork found on the tracker's era-divider rows. One item per era
that has an image.

```json
{
  "items": [
    {
      "era": "Working On Dying",
      "era_key": "working on dying",
      "image_id": 12,
      "image_url": "/api/v1/era-images/12"
    }
  ],
  "total": 1
}
```

### GET `/api/v1/era-images/{id}`

Raw image bytes with the stored `Content-Type` and
`Cache-Control: public, max-age=604800, immutable` (ids rotate on refresh).

## Search

### GET `/api/v1/search`

Searches parsed entries across all trackers.

Query parameters:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `q` | string | none | Case-insensitive search across parsed text and tracker name. |
| `tracker_id` | integer | none | Restrict results to a tracker ID. |
| `era` | string | none | Case-insensitive partial match. |
| `type` | string | none | Case-insensitive partial match. |
| `quality` | string | none | Case-insensitive partial match. |
| `has_links` | boolean | none | `true` or `false`. |
| `limit` | integer | `50` | Max `500`. |
| `offset` | integer | `0` | Pagination offset. |

Returns the same entry shape as `/api/v1/trackers/{id}/entries`.

Example:

```text
GET /api/v1/search?q=demo&quality=CD&has_links=true&limit=25
```

## Stats

### GET `/api/v1/stats`

Returns catalog counts.

```json
{
  "trackers": 523,
  "sheets": 500,
  "entries": 10000,
  "parse_errors": 12,
  "failed_trackers": 3,
  "never_parsed": 2,
  "missing_from_hub": 1
}
```

## Parse errors

### GET `/api/v1/parse-errors`

Requires the admin bearer token (`Authorization: Bearer <ADMIN_API_KEY>`).
Lists current parse problems, newest first, in a pagination envelope:
per-tracker parse failures, hub rows skipped during the last global refresh
(`error_type: "hub_row_skipped"`), and sheets that contain data but parsed to
0 entries (`error_type: "zero_entry_sheet"` — review items recorded even when
the tracker's `parse_status` is `ok`). Cleared and re-evaluated per tracker on
each successful parse.

```json
{
  "id": 7,
  "tracker_id": 42,
  "tracker_name": "Avicii",
  "source": "https://docs.google.com/spreadsheets/d/...",
  "error_type": "*errors.errorString",
  "error": "could not find a header row",
  "created_at": "2026-06-11T12:00:00Z"
}
```

## Admin Refresh

### POST `/api/v1/admin/refresh/global`

Queues or returns an already queued/running global refresh job.

Requires admin auth.

Response:

```json
{
  "id": 1,
  "scope": "global",
  "tracker_id": null,
  "status": "queued",
  "requested_at": "2026-05-11T12:00:00Z"
}
```

### POST `/api/v1/admin/refresh/trackers/{id}`

Queues or returns an already queued/running refresh job for one tracker.

Requires admin auth.

## Admin Jobs

### GET `/api/v1/admin/jobs`

Lists refresh jobs.

Requires admin auth.

Query parameters:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | integer | `50` | Max `500`. |
| `offset` | integer | `0` | Pagination offset. |

Job statuses:

| Status | Meaning |
| --- | --- |
| `queued` | Waiting to run. |
| `running` | Currently executing. |
| `succeeded` | Finished successfully. |
| `failed` | Finished with an error. |

### GET `/api/v1/admin/jobs/{id}`

Returns one refresh job.

Requires admin auth.

Response:

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

## Notes

The first API boot with an empty database queues a global TrackerHub refresh. Global refresh also runs on `REFRESH_INTERVAL`, defaulting to `1h`.

Global refresh fetches and parses tracker spreadsheets concurrently. Configure concurrency with `REFRESH_WORKERS`; the default is `8`.

Tracker parsing stores parse failures in `parse_errors`; a global refresh continues after individual tracker failures unless `FAIL_FAST_REFRESH=true`.
