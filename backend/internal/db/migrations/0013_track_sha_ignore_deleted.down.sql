DROP INDEX IF EXISTS tracks_personal_sha_uniq;
DROP INDEX IF EXISTS tracks_global_sha_uniq;

CREATE UNIQUE INDEX tracks_global_sha_uniq
    ON tracks (audio_sha256)
    WHERE owner_id IS NULL;

CREATE UNIQUE INDEX tracks_personal_sha_uniq
    ON tracks (owner_id, audio_sha256)
    WHERE owner_id IS NOT NULL;
