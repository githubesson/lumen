-- A concurrent build must be the only statement in this migration.
CREATE INDEX CONCURRENTLY tracks_visible_duration_idx ON tracks(duration_ms, id)
    WHERE deleted_at IS NULL AND library_visible = TRUE;
