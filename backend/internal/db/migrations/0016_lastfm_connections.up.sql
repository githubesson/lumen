CREATE TABLE lastfm_connections (
    user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    username           TEXT,
    session_key        TEXT,
    pending_token      TEXT,
    pending_expires_at TIMESTAMPTZ,
    connected_at       TIMESTAMPTZ,
    last_error         TEXT,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
