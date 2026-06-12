DROP INDEX IF EXISTS tracks_personal_sha_uniq;
DROP INDEX IF EXISTS tracks_global_sha_uniq;
ALTER TABLE tracks ADD CONSTRAINT tracks_audio_sha256_key UNIQUE (audio_sha256);
DROP INDEX IF EXISTS tracks_owner_idx;
ALTER TABLE tracks DROP COLUMN owner_id;
