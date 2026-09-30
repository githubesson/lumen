ALTER TABLE track_aliases DROP COLUMN IF EXISTS tags_swapped;
DROP INDEX IF EXISTS track_aliases_unranked_idx;
ALTER TABLE track_aliases DROP COLUMN IF EXISTS unranked;
ALTER TABLE tracks DROP COLUMN IF EXISTS metadata_edited_at;
