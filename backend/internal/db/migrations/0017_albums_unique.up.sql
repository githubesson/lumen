-- `UpsertAlbum` was a SELECT-then-INSERT with nothing behind it: two concurrent
-- ingests of two tracks from the same album could both miss the SELECT and both
-- INSERT, leaving two albums rows with identical (title, album_artist_id). The
-- split is not self-healing — the album page shows half a tracklist and cover
-- resolution picks whichever duplicate the planner happens to return.
--
-- Collapse the existing duplicates, then add the unique index that lets the
-- store use INSERT ... ON CONFLICT DO UPDATE instead.
--
-- album_artist_id IS NULL (compilations) must collide too, so the index is on
-- COALESCE(album_artist_id, <nil uuid>) — NULLs never collide in a plain
-- unique index.

CREATE TEMP TABLE _album_merges ON COMMIT DROP AS
SELECT id AS old_id,
       FIRST_VALUE(id) OVER (
           PARTITION BY title, COALESCE(album_artist_id, '00000000-0000-0000-0000-000000000000'::uuid)
           ORDER BY created_at ASC, id ASC
       ) AS new_id
FROM albums;
DELETE FROM _album_merges WHERE old_id = new_id;

-- Fold anything the survivor is missing up from the duplicates before dropping
-- them, so a merge never loses a cover or a release year.
UPDATE albums a
SET release_year   = COALESCE(a.release_year, agg.release_year),
    cover_art_path = COALESCE(a.cover_art_path, agg.cover_art_path),
    release_type   = COALESCE(a.release_type, agg.release_type),
    musicbrainz_id = COALESCE(a.musicbrainz_id, agg.musicbrainz_id),
    is_compilation = a.is_compilation OR agg.is_compilation,
    updated_at     = NOW()
FROM (
    SELECT m.new_id,
           MIN(d.release_year)               AS release_year,
           MIN(d.cover_art_path)             AS cover_art_path,
           MIN(d.release_type)               AS release_type,
           MIN(d.musicbrainz_id::text)::uuid AS musicbrainz_id,
           BOOL_OR(d.is_compilation)         AS is_compilation
    FROM _album_merges m
    JOIN albums d ON d.id = m.old_id
    GROUP BY m.new_id
) agg
WHERE a.id = agg.new_id;

UPDATE tracks t
SET album_id = m.new_id
FROM _album_merges m
WHERE t.album_id = m.old_id;

DELETE FROM albums a
USING _album_merges m
WHERE a.id = m.old_id;

CREATE UNIQUE INDEX IF NOT EXISTS albums_title_artist_uniq
    ON albums (title, COALESCE(album_artist_id, '00000000-0000-0000-0000-000000000000'::uuid));
