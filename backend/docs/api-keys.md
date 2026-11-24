# API keys

Scripts, home automation and other programs call Lumen's API with an API key
instead of a signed-in session. A key acts as the user who made it: it sees
what they see and can do what they can do, admin routes included when the
user is an admin.

## Making a key

In the web or desktop app, open **Settings → Connections → API keys**, name
the key after what will use it, pick when it expires (never, 30 days, 90 days
or a year) and choose **Create**. The key is shown once. Copy it then; Lumen
keeps only its SHA-256 and can't show it again. The list shows each key's
name, first characters, and when it was made, last used and expires.

Keys stop working when:

- you revoke them in Settings,
- they expire,
- you change your password (every key is revoked with your sessions),
- an admin disables your account (keys are revoked too; enabling the account
  again doesn't bring them back),
- your account is deleted.

A user can have up to 25 keys, expired ones included.

## Using a key

Send it as a bearer token on every request:

```sh
curl -H "Authorization: Bearer lumen_…" https://music.example.com/api/auth/me
```

Keys always start with `lumen_`. The server only treats bearer tokens with
that prefix as API keys, so a proxy in front of Lumen can still add its own
`Authorization` header for other purposes. A key that's wrong, revoked or
expired gets `401` with `WWW-Authenticate: Bearer error="invalid_token"`,
even if the request also carries a session cookie. A request with a key
ignores any session cookie it carries.

Responses are JSON; errors are plain text with the status code. Rate limits
are per client address, the same as for the apps. The server sends no CORS
headers, so web pages on other sites can't use a key; call the API from a
script or a server.

### What a key can't do

These need a signed-in app and answer `403` to a key, so a leaked key can't
make more keys or change its owner's password:

- `GET|POST /api/auth/api-keys`, `DELETE /api/auth/api-keys/{id}`
- `POST /api/auth/reset-password`
- `POST /api/auth/logout`
- `GET /api/activity/ws` (the playback socket; see
  [playback-websocket.md](playback-websocket.md))

An admin's key can do everything else an admin can, including inviting new
admins and disabling or deleting accounts. Someone holding a leaked admin key
can make an admin account of their own that outlives the key, so treat an
admin key like the admin password: revoke it, and check the users list, if it
may have leaked.

## Managing keys over the API

From a signed-in session (the session cookie), as the Settings page does:

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| `GET` | `/api/auth/api-keys` | | `200`, the keys, newest first |
| `POST` | `/api/auth/api-keys` | `{"name": "Stats script", "expires_in_days": 90}` | `201`, the key with `key` set |
| `DELETE` | `/api/auth/api-keys/{id}` | | `204`, or `404` if it isn't yours |

`name` is 1–100 characters. `expires_in_days` is 0 or absent for a key that
doesn't expire, otherwise 1–3650. A user at the limit gets `409`.

```json
{
  "id": "6f1c…",
  "name": "Stats script",
  "prefix": "lumen_q7XvB2",
  "created_at": "2026-11-24T10:00:00Z",
  "last_used_at": null,
  "expires_at": "2027-02-22T10:00:00Z",
  "key": "lumen_q7XvB2…"
}
```

`last_used_at` is updated at most once a minute.

## Routes

The full list is in
[internal/httpapi/router.go](../internal/httpapi/router.go). The ones most
scripts want:

| Area | Routes |
| --- | --- |
| You | `GET /api/auth/me` |
| Library | `GET /api/tracks?sort=recent\|title\|artist\|album\|duration&limit=&offset=&q=`, `GET /api/tracks/{id}` |
| Audio | `GET /api/tracks/{id}/stream` (supports `Range`), `GET /api/tracks/{id}/cover` |
| Albums, artists | `GET /api/albums`, `/api/albums/{id}`, `/api/albums/{id}/tracks`, `GET /api/artists`, `/api/artists/{id}`, `/api/artists/{id}/tracks` |
| Search | `GET /api/search?q=&type=all\|track\|album\|artist` (see the README) |
| Favorites, history | `GET /api/favorites`, `POST\|DELETE /api/tracks/{id}/favorite`, `GET /api/recent`, `POST /api/tracks/{id}/play` |
| Stats | `GET /api/stats/replay` |
| Playlists | `GET\|POST /api/playlists`, `GET\|PATCH\|DELETE /api/playlists/{id}`, `GET\|POST /api/playlists/{id}/tracks`, `DELETE /api/playlists/{id}/tracks/{pos}`, `PUT /api/playlists/{id}/order` |
| Uploads | `POST /api/library/upload` (multipart) |
| Now playing | `PUT /api/activity`, `GET /api/activity/current` |
| Admin | `/api/admin/…`: invites, users, library roots and rescans, importers, TIDAL |
