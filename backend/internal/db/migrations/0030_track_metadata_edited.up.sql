-- Set when an admin or an importer (API tracker, ArtistGrid) writes a track's
-- metadata. Dedup then never lets a duplicate file's tags replace it.
ALTER TABLE tracks ADD COLUMN metadata_edited_at TIMESTAMPTZ;

-- Aliases recorded before ingest compared duplicates. The next rescan checks
-- the tracks holding them once (AdoptFullerAliases); aliases recorded from
-- now on were compared at ingest. The TRUE default only fills existing rows.
ALTER TABLE track_aliases ADD COLUMN unranked BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE track_aliases ALTER COLUMN unranked SET DEFAULT FALSE;
CREATE INDEX track_aliases_unranked_idx ON track_aliases(track_id) WHERE unranked;

-- Marks the alias whose tags that check swapped with its track's: the alias's
-- tags came from the track's file, and the track's from the alias's file.
ALTER TABLE track_aliases ADD COLUMN tags_swapped BOOLEAN NOT NULL DEFAULT FALSE;
