-- Deduplication by audio_sha256 collapses files with identical audio into a
-- single tracks row. Before this table, the dupe's filename / title / artists
-- / album were simply discarded, making those strings unsearchable. An alias
-- row records them so search can match any variant while the library still
-- shows a single canonical track.

CREATE TABLE track_aliases (
    id           BIGSERIAL PRIMARY KEY,
    track_id     UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    file_path    TEXT NOT NULL,
    title        TEXT,
    artist_names TEXT,
    album_title  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (track_id, file_path)
);
CREATE INDEX track_aliases_track_idx ON track_aliases(track_id);
CREATE INDEX track_aliases_title_trgm ON track_aliases USING gin (title gin_trgm_ops);
CREATE INDEX track_aliases_artists_trgm ON track_aliases USING gin (artist_names gin_trgm_ops);
CREATE INDEX track_aliases_album_trgm ON track_aliases USING gin (album_title gin_trgm_ops);
