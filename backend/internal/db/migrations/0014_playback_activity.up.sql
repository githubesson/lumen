CREATE TABLE playback_activity (
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id    TEXT NOT NULL,
    device_name  TEXT NOT NULL DEFAULT '',
    track_id     TEXT NOT NULL,
    title        TEXT NOT NULL,
    artist       TEXT,
    album        TEXT,
    album_id     TEXT,
    cover_url    TEXT,
    duration_sec INTEGER,
    position_sec INTEGER NOT NULL DEFAULT 0,
    is_playing   BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, device_id)
);

CREATE INDEX playback_activity_user_updated_idx
    ON playback_activity (user_id, updated_at DESC);
