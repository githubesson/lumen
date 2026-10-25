-- An admin can link tracks that are the same song in different files: an MP3
-- and the studio WAV it was encoded from, say. The fullest-tagged track stays
-- in the library; the others point at it with linked_to and are hidden from
-- library listings (library_visible), like the TIDAL rows that only back
-- playlists. Each keeps its own row, file, tags and audio hash, so ingest,
-- rescans and dedup treat it as before. Playback picks the best file in the
-- group.
-- The reference is checked at commit: when the track others are linked to
-- is deleted, tracks_promote_linked re-points them after the statement.
ALTER TABLE tracks
    ADD COLUMN linked_to UUID REFERENCES tracks(id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT tracks_linked_to_other CHECK (linked_to <> id);

CREATE INDEX tracks_linked_to_idx ON tracks(linked_to) WHERE linked_to IS NOT NULL;

-- Moves playlist entries, listening stats and history from one track to
-- another, as TIDAL auto-download adoption does: the playlist locks first,
-- in id order, then stats before history (RecordPlay's order).
CREATE FUNCTION move_track_refs(from_id UUID, to_id UUID) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM playlists
    WHERE id IN (SELECT playlist_id FROM playlist_tracks WHERE track_id = from_id)
    ORDER BY id
    FOR UPDATE;
    UPDATE playlist_tracks SET track_id = to_id WHERE track_id = from_id;

    -- One statement: the DELETE waits for a play being recorded on from_id
    -- and returns its count. Reading, then deleting in a second statement,
    -- copied the count before that play and deleted the row after it.
    WITH moved AS (
        DELETE FROM user_track_stats WHERE track_id = from_id RETURNING *
    )
    INSERT INTO user_track_stats
        (user_id, track_id, play_count, last_played_at, rating, favorited, favorited_at)
    SELECT user_id, to_id, play_count, last_played_at, rating, favorited, favorited_at
    FROM moved
    ON CONFLICT (user_id, track_id) DO UPDATE SET
        play_count     = user_track_stats.play_count + EXCLUDED.play_count,
        last_played_at = GREATEST(user_track_stats.last_played_at, EXCLUDED.last_played_at),
        rating         = COALESCE(user_track_stats.rating, EXCLUDED.rating),
        favorited_at   = CASE WHEN user_track_stats.favorited
                              THEN user_track_stats.favorited_at
                              ELSE EXCLUDED.favorited_at END,
        favorited      = user_track_stats.favorited OR EXCLUDED.favorited;

    UPDATE play_history SET track_id = to_id WHERE track_id = from_id;
END $$;

-- When a track that others are linked to is deleted (file gone, admin
-- delete) or soft-deleted (root purge), the fullest of them takes its place,
-- ranked as library.linkShownOrder ranks them: edited on purpose, then with
-- performers, then on a real album. The rest link to it, and the gone
-- track's playlist entries, stats and history move over, so the song stays
-- in the library and in playlists.
CREATE FUNCTION linked_heir(gone UUID, besides UUID DEFAULT NULL) RETURNS UUID
LANGUAGE sql AS $$
    SELECT t.id
    FROM tracks t
    WHERE t.linked_to = gone AND t.deleted_at IS NULL AND t.id IS DISTINCT FROM besides
    ORDER BY t.metadata_edited_at IS NOT NULL DESC,
             EXISTS (SELECT 1 FROM track_artists fa WHERE fa.track_id = t.id AND fa.role <> 'composer') DESC,
             EXISTS (SELECT 1 FROM albums fal WHERE fal.id = t.album_id
                     AND NOT (fal.title = 'Others' AND fal.album_artist_id IS NULL
                              AND NOT EXISTS (SELECT 1 FROM track_artists fa
                                              WHERE fa.track_id = t.id AND fa.role <> 'composer'))) DESC,
             t.created_at, t.id
    LIMIT 1
$$;

-- Where a hidden track's references go when it's deleted or soft-deleted:
-- the track it's linked to while that one is live; else that track's heir,
-- when the same statement took both and the heir isn't shown yet (never the
-- hidden track itself, which a BEFORE DELETE trigger still sees); else the
-- track it was re-pointed to, when the shown track's trigger ran first.
CREATE FUNCTION linked_target(hidden UUID, shown UUID) RETURNS UUID
LANGUAGE sql AS $$
    SELECT COALESCE(
        (SELECT id FROM tracks WHERE id = shown AND deleted_at IS NULL),
        linked_heir(shown, hidden),
        (SELECT h.id FROM tracks t JOIN tracks h ON h.id = t.linked_to
         WHERE t.id = hidden AND h.id <> hidden AND h.deleted_at IS NULL))
$$;

-- A delete cascades the track's playlist entries and stats away, so they move
-- before it, and before the TIDAL fallback of 0020 (triggers fire in name
-- order), which then finds none left: a shown track's to its heir, a hidden
-- track's (a client that still held its id wrote them) to linked_target.
-- The trigger writes only other tables; updating tracks rows here would fail
-- a statement that deletes those rows too.
CREATE FUNCTION tracks_move_linked_refs() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    heir UUID;
BEGIN
    IF OLD.linked_to IS NULL THEN
        heir := linked_heir(OLD.id);
    ELSE
        heir := linked_target(OLD.id, OLD.linked_to);
    END IF;
    IF heir IS NOT NULL THEN
        PERFORM move_track_refs(OLD.id, heir);
    END IF;
    RETURN OLD;
END $$;

CREATE TRIGGER tracks_linked_refs_on_delete
    BEFORE DELETE ON tracks
    FOR EACH ROW WHEN (OLD.source = 'local')
    EXECUTE FUNCTION tracks_move_linked_refs();

-- After the statement, the heir is shown and the rest re-pointed; a soft
-- delete keeps its references, so they move now. Links are one level deep
-- (library.showLinked), but should a track linked to another still have
-- tracks linked to it, deleting it moves them up rather than failing the
-- foreign key.
CREATE FUNCTION tracks_promote_linked() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    heir UUID;
BEGIN
    IF OLD.linked_to IS NOT NULL THEN
        UPDATE tracks SET linked_to = OLD.linked_to WHERE linked_to = OLD.id;
        -- A soft-deleted hidden track's references go where a deleted one's
        -- do before the delete.
        IF TG_OP = 'UPDATE' THEN
            heir := linked_target(OLD.id, OLD.linked_to);
            IF heir IS NOT NULL THEN
                PERFORM move_track_refs(OLD.id, heir);
            END IF;
        END IF;
        RETURN NULL;
    END IF;
    heir := linked_heir(OLD.id);
    IF heir IS NULL THEN
        -- Only deleted tracks are left linked to it.
        UPDATE tracks SET linked_to = NULL, library_visible = TRUE WHERE linked_to = OLD.id;
        RETURN NULL;
    END IF;
    UPDATE tracks SET linked_to = NULL, library_visible = TRUE, updated_at = NOW() WHERE id = heir;
    UPDATE tracks SET linked_to = heir WHERE linked_to = OLD.id;
    IF TG_OP = 'UPDATE' THEN
        PERFORM move_track_refs(OLD.id, heir);
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER tracks_promote_linked_on_delete
    AFTER DELETE ON tracks
    FOR EACH ROW WHEN (OLD.source = 'local')
    EXECUTE FUNCTION tracks_promote_linked();

CREATE TRIGGER tracks_promote_linked_on_soft_delete
    AFTER UPDATE OF deleted_at ON tracks
    FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
                       AND NEW.source = 'local')
    EXECUTE FUNCTION tracks_promote_linked();
