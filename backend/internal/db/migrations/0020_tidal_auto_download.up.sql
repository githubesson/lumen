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

-- A saved copy replaced its TIDAL row in playlists. If that copy is deleted
-- (file gone from disk, admin delete) or soft-deleted (root purge), put the
-- entries back on the TIDAL row instead of letting them cascade away or go
-- hidden: the song stays in the playlist, and an opted-in playlist saves it
-- again.
CREATE FUNCTION tidal_restore_remote_entries() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE playlist_tracks pt
    SET track_id = remote.id
    FROM (
        SELECT t.id
        FROM tidal_downloads d
        JOIN tracks t ON t.source = 'tidal' AND t.external_id = d.tidal_id
         AND t.deleted_at IS NULL
        WHERE d.local_track_id = OLD.id AND d.status IN ('downloaded', 'existing')
        ORDER BY d.created_at, d.tidal_id
        LIMIT 1
    ) remote
    WHERE pt.track_id = OLD.id;
    RETURN OLD;
END $$;

CREATE TRIGGER tracks_restore_tidal_on_delete
    BEFORE DELETE ON tracks
    FOR EACH ROW WHEN (OLD.source = 'local')
    EXECUTE FUNCTION tidal_restore_remote_entries();

CREATE TRIGGER tracks_restore_tidal_on_soft_delete
    AFTER UPDATE OF deleted_at ON tracks
    FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.source = 'local')
    EXECUTE FUNCTION tidal_restore_remote_entries();
