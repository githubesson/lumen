-- Playlist reads now use user_track_stats.play_count instead of counting history
-- for every track. Repair legacy counters once, preserving favorites and ratings.
-- Block play writes during reconciliation; RecordPlay takes locks in this order.
LOCK TABLE user_track_stats, play_history IN SHARE ROW EXCLUSIVE MODE;

WITH history_counts AS (
    SELECT user_id, track_id, COUNT(*)::integer AS play_count,
           MAX(played_at) AS last_played_at
    FROM play_history
    GROUP BY user_id, track_id
)
INSERT INTO user_track_stats (user_id, track_id, play_count, last_played_at)
SELECT COALESCE(h.user_id, s.user_id), COALESCE(h.track_id, s.track_id),
       COALESCE(h.play_count, 0), h.last_played_at
FROM history_counts h
FULL JOIN user_track_stats s USING (user_id, track_id)
WHERE s.user_id IS NULL OR s.play_count IS DISTINCT FROM COALESCE(h.play_count, 0)
ON CONFLICT (user_id, track_id) DO UPDATE
SET play_count = EXCLUDED.play_count;
