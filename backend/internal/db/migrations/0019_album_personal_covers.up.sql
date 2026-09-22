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

-- Backfill only where it changes nothing anyone sees: an album whose tracks
-- (live or deleted) all belong to one user has only ever been visible to that
-- user, so its cover moves to that user's personal slot. Anything else keeps
-- its shared cover, since its origin (global ingest, admin) can't be told apart.
INSERT INTO album_personal_covers (album_id, user_id, cover_art_path)
SELECT a.id, sole.owner_id, a.cover_art_path
FROM albums a
JOIN (
    SELECT t.album_id, MIN(t.owner_id::text)::uuid AS owner_id
    FROM tracks t
    WHERE t.album_id IS NOT NULL
    GROUP BY t.album_id
    HAVING COUNT(*) FILTER (WHERE t.owner_id IS NULL) = 0
       AND COUNT(DISTINCT t.owner_id) = 1
) sole ON sole.album_id = a.id
WHERE NULLIF(a.cover_art_path, '') IS NOT NULL;

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
