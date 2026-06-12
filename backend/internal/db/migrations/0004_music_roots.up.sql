-- Extra music roots managed at runtime by an admin. The primary root still
-- lives in MUSIC_PATH env (uploads and cover storage go there); rows here are
-- additional scan/watch locations.
CREATE TABLE music_roots (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    path       TEXT NOT NULL UNIQUE,
    label      TEXT NOT NULL DEFAULT '',
    enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
