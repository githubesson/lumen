-- Set when an admin or an importer (API tracker, ArtistGrid) writes a track's
-- metadata. Dedup then never lets a duplicate file's tags replace it.
ALTER TABLE tracks ADD COLUMN metadata_edited_at TIMESTAMPTZ;
