DROP TRIGGER IF EXISTS tracks_restore_tidal_on_soft_delete ON tracks;
DROP TRIGGER IF EXISTS tracks_restore_tidal_on_delete ON tracks;
DROP FUNCTION IF EXISTS tidal_restore_remote_entries();
DROP TABLE IF EXISTS tidal_downloads;
DROP INDEX IF EXISTS user_track_stats_track_idx;
DROP INDEX IF EXISTS play_history_track_idx;
ALTER TABLE playlist_tracks DROP COLUMN IF EXISTS tidal_origin;
DROP INDEX IF EXISTS playlists_tidal_auto_download_idx;
ALTER TABLE playlists DROP COLUMN IF EXISTS tidal_auto_download;
