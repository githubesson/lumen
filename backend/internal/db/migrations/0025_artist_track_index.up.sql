-- A concurrent build must be the only statement in this migration.
CREATE INDEX CONCURRENTLY track_artists_artist_track_idx ON track_artists(artist_id, track_id);
