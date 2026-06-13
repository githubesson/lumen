DROP INDEX IF EXISTS tracks_library_visible_idx;
DROP INDEX IF EXISTS tracks_source_idx;
DROP INDEX IF EXISTS tracks_external_source_uniq;

ALTER TABLE tracks
    DROP COLUMN IF EXISTS library_visible,
    DROP COLUMN IF EXISTS external_meta,
    DROP COLUMN IF EXISTS external_id,
    DROP COLUMN IF EXISTS source;
