-- Albums are shared rows matched by (title, album artist), so a personal
-- upload used to be able to fill the cover of an album every user sees.
-- albums.cover_art_path now only holds artwork from global ingest or an
-- admin; artwork from personal uploads is kept per user here and only shown
-- to that user, so two users with the same album each keep their own art.
CREATE TABLE album_personal_covers (
    album_id       UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cover_art_path TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (album_id, user_id)
);

-- Best-effort backfill: a cover on an album with no global tracks can only
-- have come from a personal upload. Attribute it to the album's earliest
-- uploader, then drop it from the shared row.
INSERT INTO album_personal_covers (album_id, user_id, cover_art_path)
SELECT a.id, first_owner.owner_id, a.cover_art_path
FROM albums a
JOIN (
    SELECT DISTINCT ON (t.album_id) t.album_id, t.owner_id
    FROM tracks t
    WHERE t.owner_id IS NOT NULL AND t.album_id IS NOT NULL
    ORDER BY t.album_id, t.created_at ASC, t.id ASC
) first_owner ON first_owner.album_id = a.id
WHERE NULLIF(a.cover_art_path, '') IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM tracks g
      WHERE g.album_id = a.id AND g.owner_id IS NULL AND g.deleted_at IS NULL
  );

UPDATE albums a
SET cover_art_path = NULL
FROM album_personal_covers pc
WHERE pc.album_id = a.id AND pc.cover_art_path = a.cover_art_path;

-- Aliases are shown to every user who can see the canonical track. Personal
-- uploads that deduplicated into a global track leaked the uploader's tags and
-- file path (.users/<uid>/...) that way; ingest no longer records them.
DELETE FROM track_aliases al
USING tracks t
WHERE al.track_id = t.id
  AND t.owner_id IS NULL
  AND al.file_path LIKE '%/.users/%';
