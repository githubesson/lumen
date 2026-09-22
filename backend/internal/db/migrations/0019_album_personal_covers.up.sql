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

-- No backfill: an existing albums.cover_art_path may come from global ingest
-- or an admin even when the album's remaining tracks are all personal, so its
-- origin can't be inferred. Legacy covers stay shared; admins can clear any
-- that were supplied by a personal upload.

-- Aliases are shown to every user who can see the canonical track. Personal
-- uploads that deduplicated into a global track leaked the uploader's tags and
-- file path (.users/<uid>/...) that way; ingest no longer records them.
DELETE FROM track_aliases al
USING tracks t
WHERE al.track_id = t.id
  AND t.owner_id IS NULL
  AND al.file_path LIKE '%/.users/%';
