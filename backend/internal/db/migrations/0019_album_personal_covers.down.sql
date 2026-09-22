-- Personal covers are dropped rather than copied into albums.cover_art_path:
-- that column is shared, and nothing identifies a personal cover as safe to
-- show every viewer.
DROP TABLE album_personal_covers;
