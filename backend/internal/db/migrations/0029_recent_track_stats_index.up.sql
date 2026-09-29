-- A concurrent build must be the only statement in this migration.
CREATE INDEX CONCURRENTLY user_track_stats_recent_idx
    ON user_track_stats(user_id, last_played_at DESC, track_id)
    WHERE last_played_at IS NOT NULL;
