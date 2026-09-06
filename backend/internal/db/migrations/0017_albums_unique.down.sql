-- The album merge is not reversible; only the constraint comes back off.
DROP INDEX IF EXISTS albums_title_artist_uniq;
