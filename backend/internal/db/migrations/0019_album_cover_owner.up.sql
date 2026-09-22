-- Albums are shared rows matched by (title, album artist), so a personal
-- upload used to be able to fill the cover of an album every user sees.
-- cover_owner_id records which user's personal upload supplied the current
-- cover (NULL = global ingest or an admin). Reads only show a personal cover
-- to that user, and global ingest replaces personal covers.
ALTER TABLE albums ADD COLUMN cover_owner_id UUID;

-- Best-effort backfill: a cover on an album with no global tracks can only
-- have come from a personal upload. Attribute it to the earliest uploader.
UPDATE albums a
SET cover_owner_id = first_owner.owner_id
FROM (
    SELECT DISTINCT ON (t.album_id) t.album_id, t.owner_id
    FROM tracks t
    WHERE t.owner_id IS NOT NULL AND t.album_id IS NOT NULL
    ORDER BY t.album_id, t.created_at ASC, t.id ASC
) first_owner
WHERE first_owner.album_id = a.id
  AND a.cover_art_path IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM tracks g
      WHERE g.album_id = a.id AND g.owner_id IS NULL AND g.deleted_at IS NULL
  );

-- Aliases are shown to every user who can see the canonical track. Personal
-- uploads that deduplicated into a global track leaked the uploader's tags and
-- file path (.users/<uid>/...) that way; ingest no longer records them.
DELETE FROM track_aliases al
USING tracks t
WHERE al.track_id = t.id
  AND t.owner_id IS NULL
  AND al.file_path LIKE '%/.users/%';
