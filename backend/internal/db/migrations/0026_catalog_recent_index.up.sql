-- A concurrent build must be the only statement in this migration.
CREATE INDEX CONCURRENTLY tracks_visible_recent_idx ON tracks(created_at DESC, id)
    WHERE deleted_at IS NULL AND library_visible = TRUE;
