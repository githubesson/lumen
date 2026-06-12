-- Collapse duplicate artists that differ only in case ("Juice Wrld" vs
-- "juice wrld" vs "JUICE WRLD"). Keep the earliest row per lowercase group;
-- re-point track_artists and albums.album_artist_id to it; delete the rest.
-- Then swap the case-sensitive UNIQUE (name) constraint for a case-insensitive
-- unique index on LOWER(name), so future ingests dedup automatically.

CREATE TEMP TABLE _artist_merges ON COMMIT DROP AS
SELECT id AS old_id,
       FIRST_VALUE(id) OVER (PARTITION BY LOWER(name) ORDER BY created_at ASC, id ASC) AS new_id
FROM artists;
DELETE FROM _artist_merges WHERE old_id = new_id;

UPDATE track_artists ta
SET artist_id = m.new_id
FROM _artist_merges m
WHERE ta.artist_id = m.old_id
  AND NOT EXISTS (
      SELECT 1 FROM track_artists ex
      WHERE ex.track_id = ta.track_id AND ex.artist_id = m.new_id
  );

DELETE FROM track_artists ta
USING _artist_merges m
WHERE ta.artist_id = m.old_id;

UPDATE albums
SET album_artist_id = m.new_id
FROM _artist_merges m
WHERE albums.album_artist_id = m.old_id;

DELETE FROM artists a
USING _artist_merges m
WHERE a.id = m.old_id;

ALTER TABLE artists DROP CONSTRAINT IF EXISTS artists_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS artists_name_lower_uniq ON artists (LOWER(name));
