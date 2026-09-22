UPDATE albums a
SET cover_art_path = pc.cover_art_path
FROM album_personal_covers pc
WHERE pc.album_id = a.id AND NULLIF(a.cover_art_path, '') IS NULL;

DROP TABLE album_personal_covers;
