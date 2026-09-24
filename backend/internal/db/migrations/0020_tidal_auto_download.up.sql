-- Playlists can opt in to having their TIDAL tracks saved into the local
-- library. The worker downloads each track once, then repoints every playlist
-- entry (and the users' stats) from the remote row to the local copy.
ALTER TABLE playlists
    ADD COLUMN tidal_auto_download BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX playlists_tidal_auto_download_idx
    ON playlists(id) WHERE tidal_auto_download;

-- One row per TIDAL track id, not per playlist: a track in several playlists
-- is downloaded once. local_track_id is the library copy that `tidal:<id>`
-- references resolve to from then on.
CREATE TABLE tidal_downloads (
    tidal_id        TEXT PRIMARY KEY,
    status          TEXT NOT NULL CHECK (status IN ('downloaded', 'existing', 'failed')),
    local_track_id  UUID REFERENCES tracks(id) ON DELETE SET NULL,
    file_path       TEXT NOT NULL DEFAULT '',
    title           TEXT NOT NULL DEFAULT '',
    artist          TEXT NOT NULL DEFAULT '',
    error           TEXT NOT NULL DEFAULT '',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tidal_downloads_updated_idx ON tidal_downloads(updated_at DESC);
CREATE INDEX tidal_downloads_local_track_idx ON tidal_downloads(local_track_id);
