-- The release's full date ("2020-03-27") and copyright line, as TIDAL
-- gives them, for the album page's footer. Empty until the next fetch.
ALTER TABLE tidal_albums
    ADD COLUMN release_date TEXT NOT NULL DEFAULT '',
    ADD COLUMN copyright    TEXT NOT NULL DEFAULT '';
