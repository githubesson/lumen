DROP TABLE IF EXISTS tidal_download_requests;
ALTER TABLE tidal_downloads DROP COLUMN IF EXISTS tidal_album_id;
DROP INDEX IF EXISTS albums_tidal_album_idx;
ALTER TABLE albums DROP COLUMN IF EXISTS tidal_album_id;
DROP TABLE IF EXISTS tidal_albums;
