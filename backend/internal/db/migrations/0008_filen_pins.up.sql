CREATE TABLE filen_share_pins (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    root_id               UUID REFERENCES music_roots(id) ON DELETE CASCADE,
    root_path             TEXT NOT NULL,
    destination_subdir    TEXT NOT NULL DEFAULT '',
    share_url             TEXT NOT NULL,
    password              TEXT NOT NULL DEFAULT '',
    label                 TEXT NOT NULL DEFAULT '',
    enabled               BOOLEAN NOT NULL DEFAULT TRUE,
    scan_interval_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (scan_interval_seconds >= 300),
    last_scan_at          TIMESTAMPTZ,
    last_success_at       TIMESTAMPTZ,
    last_error            TEXT NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (root_path, destination_subdir, share_url)
);
CREATE INDEX filen_share_pins_due_idx
    ON filen_share_pins(enabled, last_scan_at);
CREATE INDEX filen_share_pins_root_idx
    ON filen_share_pins(root_path);

CREATE TABLE filen_downloads (
    id            BIGSERIAL PRIMARY KEY,
    pin_id        UUID NOT NULL REFERENCES filen_share_pins(id) ON DELETE CASCADE,
    source_path   TEXT NOT NULL,
    file_path     TEXT NOT NULL DEFAULT '',
    size_bytes    BIGINT NOT NULL DEFAULT 0,
    status        TEXT NOT NULL CHECK (status IN ('downloaded', 'existing', 'skipped', 'failed')),
    error         TEXT NOT NULL DEFAULT '',
    track_id      UUID REFERENCES tracks(id) ON DELETE SET NULL,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    downloaded_at TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (pin_id, source_path)
);
CREATE INDEX filen_downloads_pin_idx
    ON filen_downloads(pin_id, updated_at DESC);
CREATE INDEX filen_downloads_status_idx
    ON filen_downloads(status);
