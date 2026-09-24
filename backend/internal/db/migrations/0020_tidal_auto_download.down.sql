DROP TABLE IF EXISTS tidal_downloads;
DROP INDEX IF EXISTS playlists_tidal_auto_download_idx;
ALTER TABLE playlists DROP COLUMN IF EXISTS tidal_auto_download;
