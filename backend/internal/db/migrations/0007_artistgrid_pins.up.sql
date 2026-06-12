CREATE TABLE artistgrid_tracker_pins (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    root_id               UUID REFERENCES music_roots(id) ON DELETE CASCADE,
    root_path             TEXT NOT NULL,
    destination_subdir    TEXT NOT NULL DEFAULT '',
    tracker_id            TEXT NOT NULL,
    tracker_url           TEXT NOT NULL DEFAULT '',
    tab                   TEXT NOT NULL DEFAULT '',
    label                 TEXT NOT NULL DEFAULT '',
    primary_artist        TEXT NOT NULL DEFAULT '',
    enabled               BOOLEAN NOT NULL DEFAULT TRUE,
    scan_interval_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (scan_interval_seconds >= 300),
    last_scan_at          TIMESTAMPTZ,
    last_success_at       TIMESTAMPTZ,
    last_error            TEXT NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (root_path, destination_subdir, tracker_id, tab)
);
CREATE INDEX artistgrid_tracker_pins_due_idx
    ON artistgrid_tracker_pins(enabled, last_scan_at);
CREATE INDEX artistgrid_tracker_pins_root_idx
    ON artistgrid_tracker_pins(root_path);

CREATE TABLE artistgrid_downloads (
    id            BIGSERIAL PRIMARY KEY,
    pin_id        UUID NOT NULL REFERENCES artistgrid_tracker_pins(id) ON DELETE CASCADE,
    source_url    TEXT NOT NULL,
    resolved_url  TEXT NOT NULL DEFAULT '',
    file_path     TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL CHECK (status IN ('downloaded', 'existing', 'skipped', 'failed')),
    error         TEXT NOT NULL DEFAULT '',
    track_id      UUID REFERENCES tracks(id) ON DELETE SET NULL,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    downloaded_at TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (pin_id, source_url)
);
CREATE INDEX artistgrid_downloads_pin_idx
    ON artistgrid_downloads(pin_id, updated_at DESC);
CREATE INDEX artistgrid_downloads_status_idx
    ON artistgrid_downloads(status);
