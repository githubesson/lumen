-- Recent reads now use the same summary rows as playlist play counts. Repair
-- timestamps (including missing rows) without changing favorites or ratings.
-- RecordPlay and TIDAL adoption take locks in this order too.
LOCK TABLE user_track_stats, play_history IN SHARE ROW EXCLUSIVE MODE;
WITH history AS (
    SELECT user_id, track_id, COUNT(*)::integer AS play_count,
           MAX(played_at) AS last_played_at
    FROM play_history
    GROUP BY user_id, track_id
)
INSERT INTO user_track_stats(user_id, track_id, play_count, last_played_at)
SELECT COALESCE(h.user_id, s.user_id), COALESCE(h.track_id, s.track_id),
       COALESCE(s.play_count, h.play_count, 0), h.last_played_at
FROM history h
FULL JOIN user_track_stats s USING (user_id, track_id)
WHERE s.user_id IS NULL OR s.last_played_at IS DISTINCT FROM h.last_played_at
ON CONFLICT (user_id, track_id) DO UPDATE
SET last_played_at = EXCLUDED.last_played_at;
