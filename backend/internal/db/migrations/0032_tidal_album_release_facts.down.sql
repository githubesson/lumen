ALTER TABLE tidal_albums
    DROP COLUMN IF EXISTS copyright,
    DROP COLUMN IF EXISTS release_date;
