-- Add owner_id to tracks. NULL means the track is part of the global (admin)
-- library; any non-NULL value means it's a personal upload visible only to
-- that user.
ALTER TABLE tracks
    ADD COLUMN owner_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX tracks_owner_idx ON tracks(owner_id);

-- The SHA-256 uniqueness constraint was global before. Split it into two
-- partial indexes:
--   - one global track per SHA (admins can't duplicate the global copy)
--   - one personal track per (user, SHA) (a user can't duplicate their own
--     upload; but different users can each have their own personal copy,
--     and personal rows can coexist with a global row for now — the ingest
--     service dedups semantically).
ALTER TABLE tracks DROP CONSTRAINT tracks_audio_sha256_key;

CREATE UNIQUE INDEX tracks_global_sha_uniq
    ON tracks (audio_sha256)
    WHERE owner_id IS NULL;

CREATE UNIQUE INDEX tracks_personal_sha_uniq
    ON tracks (owner_id, audio_sha256)
    WHERE owner_id IS NOT NULL;
