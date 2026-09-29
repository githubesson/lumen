-- A concurrent build must be the only statement in this migration.
CREATE INDEX CONCURRENTLY tracks_visible_title_idx ON tracks(LOWER(title), id)
    WHERE deleted_at IS NULL AND library_visible = TRUE;
