# Playback WebSocket protocol

Lumen uses one authenticated endpoint and one additive protocol:

```text
GET /api/activity/ws?device_id=<stable-device-id>
protocol: 1
```

The session cookie authenticates the connection. Every message is scoped to
that session's user, and a device can only address another online device for
the same user. Existing activity-only clients remain compatible: server
message types they do not recognize are safe to ignore.

Every client message carries a monotonically increasing `revision` for that
connection. Replayed or out-of-order revisions are ignored.

## Activity messages

Existing clients publish playback state with `activity.update` and remove it
with `activity.clear`. The server sends a personalized `activity.snapshot`
that excludes the receiving device.

```json
{
  "type": "activity.update",
  "protocol": 1,
  "revision": 1,
  "activity": {
    "device_id": "desktop-id",
    "device_name": "Desktop",
    "track_id": "track-id",
    "title": "Track title",
    "position_sec": 12,
    "is_playing": true,
    "volume": 0.65,
    "muted": false
  }
}
```

`volume` and `muted` are optional for older publishers. Updated clients send
them on connection and whenever output volume changes, allowing controllers to
reconcile their controls with the target's authoritative state.

## Device registration

Updated clients opt into device discovery and remote control after connecting:

```json
{
  "type": "device.hello",
  "protocol": 1,
  "revision": 1,
  "device_name": "Desktop",
  "capabilities": ["playback", "seek", "volume", "queue"],
  "control_enabled": true
}
```

Supported capabilities are:

- `playback`: `play_track`, `set_playing`, `next`, and `previous`
- `seek`: `seek`
- `volume`: `set_volume` and `set_muted`
- `queue`: `set_shuffle` and `set_repeat`

Only connections that sent `device.hello` appear in `devices.snapshot`.
Activity-only clients continue to work but are not remotely controllable.

```json
{
  "type": "devices.snapshot",
  "protocol": 1,
  "devices": [
    {
      "device_id": "desktop-id",
      "device_name": "Desktop",
      "online": true,
      "control_enabled": true,
      "capabilities": ["playback", "queue", "seek", "volume"],
      "connected_at": "2026-07-11T10:00:00Z",
      "activity": null
    }
  ]
}
```

The snapshot is refreshed when devices connect, announce, disconnect, or
publish activity. Online presence is intentionally ephemeral and in-memory;
playback activity remains durable in PostgreSQL.

## Commands

The controller sends a UUID command ID, target device ID, action, and strictly
validated arguments:

```json
{
  "type": "playback.command",
  "protocol": 1,
  "revision": 2,
  "command_id": "5f1d8534-5f14-4ef3-ae47-a91fa6107cb8",
  "target_device_id": "desktop-id",
  "action": "set_playing",
  "args": { "playing": false }
}
```

The target receives the authoritative source and target IDs:

```json
{
  "type": "playback.command",
  "protocol": 1,
  "command_id": "5f1d8534-5f14-4ef3-ae47-a91fa6107cb8",
  "source_device_id": "phone-id",
  "target_device_id": "desktop-id",
  "action": "set_playing",
  "args": { "playing": false }
}
```

Supported actions and arguments:

| Action | Arguments |
| --- | --- |
| `play_track` | `{ "track": TrackListItem, "queue": TrackListItem[1..50] }` |
| `set_playing` | `{ "playing": boolean }` |
| `next` | `{}` |
| `previous` | `{}` |
| `seek` | `{ "position_sec": 0..86400 }` |
| `set_volume` | `{ "volume": 0..1 }` |
| `set_muted` | `{ "muted": boolean }` |
| `set_shuffle` | `{ "shuffle": boolean }` |
| `set_repeat` | `{ "repeat": "off" | "all" | "one" }` |

After executing the command, the target acknowledges it:

```json
{
  "type": "playback.command_result",
  "protocol": 1,
  "revision": 3,
  "command_id": "5f1d8534-5f14-4ef3-ae47-a91fa6107cb8",
  "status": "applied"
}
```

Targets may return `applied`, `rejected`, or `unsupported`. The server may
return `offline`, `busy`, `pending`, or `timeout`. Results sent to the
controller include both source and target device IDs plus an optional `error`.

Command IDs are deduplicated for two minutes. Commands are never persisted or
replayed to offline devices. An online target has ten seconds to acknowledge a
command before the controller receives `timeout`. A source connection may send
at most 30 commands per second.

## Deployment constraint

Device routing is currently held in the backend process. Run one backend
replica. Before horizontally scaling, move presence and command delivery to a
shared transport such as Redis Pub/Sub or Postgres `LISTEN/NOTIFY`.
