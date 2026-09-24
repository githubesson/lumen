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

-- Adoption, the delete fallback below, and the retired-row sweep move stats
-- and history by track; without these both are full scans (as were the
-- cascades on every track delete).
CREATE INDEX IF NOT EXISTS play_history_track_idx ON play_history(track_id);
CREATE INDEX IF NOT EXISTS user_track_stats_track_idx ON user_track_stats(track_id);

-- The TIDAL id a playlist entry was saved from, set when auto-download
-- repoints the entry to the library copy. NULL for every other entry.
ALTER TABLE playlist_tracks ADD COLUMN tidal_origin TEXT;

-- A saved copy replaced TIDAL rows in playlists. If that copy is deleted
-- (file gone from disk, admin delete) or soft-deleted (root purge):
--   * each entry saved from TIDAL goes back to its own TIDAL track instead of
--     cascading away or going hidden; entries added as the library track
--     itself are left to the usual deletion rules;
--   * a copy that only exists because it was downloaded, for a single TIDAL
--     track, carries nothing but that track's listening history, so the
--     history goes back too. A copy that also stands in for other TIDAL ids
--     holds their merged history, which can't be split: like any library
--     track's, it goes with the copy.
-- An opted-in playlist then saves the track again, and adoption merges the
-- history onto the new copy.
CREATE FUNCTION tidal_restore_remote_entries() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    remote_id UUID;
BEGIN
    -- Take the playlist locks every other playlist mutation takes first, in
    -- id order, so a concurrent reorder cannot reinsert a stale snapshot of
    -- these entries after they are moved.
    PERFORM 1 FROM playlists
    WHERE id IN (SELECT playlist_id FROM playlist_tracks WHERE track_id = OLD.id)
    ORDER BY id
    FOR UPDATE;

    UPDATE playlist_tracks pt
    SET track_id = t.id, tidal_origin = NULL
    FROM tracks t
    WHERE pt.track_id = OLD.id
      AND pt.tidal_origin IS NOT NULL
      AND t.source = 'tidal' AND t.external_id = pt.tidal_origin
      AND t.deleted_at IS NULL;

    SELECT t.id INTO remote_id
    FROM tidal_downloads d
    JOIN tracks t ON t.source = 'tidal' AND t.external_id = d.tidal_id
     AND t.deleted_at IS NULL
    WHERE d.local_track_id = OLD.id AND d.status = 'downloaded'
      AND NOT EXISTS (
          SELECT 1 FROM tidal_downloads o
          WHERE o.local_track_id = OLD.id AND o.tidal_id <> d.tidal_id
            AND o.status IN ('downloaded', 'existing'));
    IF remote_id IS NOT NULL THEN
        INSERT INTO user_track_stats
            (user_id, track_id, play_count, last_played_at, rating, favorited, favorited_at)
        SELECT user_id, remote_id, play_count, last_played_at, rating, favorited, favorited_at
        FROM user_track_stats WHERE track_id = OLD.id
        ON CONFLICT (user_id, track_id) DO UPDATE SET
            play_count     = user_track_stats.play_count + EXCLUDED.play_count,
            last_played_at = GREATEST(user_track_stats.last_played_at, EXCLUDED.last_played_at),
            rating         = COALESCE(user_track_stats.rating, EXCLUDED.rating),
            favorited_at   = CASE WHEN user_track_stats.favorited
                                  THEN user_track_stats.favorited_at
                                  ELSE EXCLUDED.favorited_at END,
            favorited      = user_track_stats.favorited OR EXCLUDED.favorited;
        DELETE FROM user_track_stats WHERE track_id = OLD.id;
        UPDATE play_history SET track_id = remote_id WHERE track_id = OLD.id;
    END IF;
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
