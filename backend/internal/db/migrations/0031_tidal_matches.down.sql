ALTER TABLE albums DROP COLUMN IF EXISTS metadata_edited_at;
DROP INDEX IF EXISTS artistgrid_downloads_track_idx;
DROP TABLE IF EXISTS tidal_match_albums;
DROP TABLE IF EXISTS tidal_matches;
