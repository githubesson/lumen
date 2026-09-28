-- A cover image the playlist's owner chose, stored under covers/ like album
-- art (SweepOrphanCovers counts these as references). NULL uses the art of
-- the playlist's first track.
ALTER TABLE playlists ADD COLUMN cover_art_path TEXT;
