DROP TRIGGER IF EXISTS tracks_promote_linked_on_soft_delete ON tracks;
DROP TRIGGER IF EXISTS tracks_promote_linked_on_delete ON tracks;
DROP TRIGGER IF EXISTS tracks_linked_refs_on_delete ON tracks;
DROP FUNCTION IF EXISTS tracks_promote_linked();
DROP FUNCTION IF EXISTS tracks_move_linked_refs();
DROP FUNCTION IF EXISTS linked_target(UUID, UUID);
DROP FUNCTION IF EXISTS linked_heir(UUID, UUID);
DROP FUNCTION IF EXISTS move_track_refs(UUID, UUID);
-- Linked tracks come back as tracks of their own.
UPDATE tracks SET library_visible = TRUE WHERE linked_to IS NOT NULL;
DROP INDEX IF EXISTS tracks_linked_to_idx;
ALTER TABLE tracks DROP CONSTRAINT IF EXISTS tracks_linked_to_other, DROP COLUMN IF EXISTS linked_to;
