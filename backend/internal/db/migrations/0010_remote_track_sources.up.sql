ALTER TABLE tracks
    ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'tidal')),
    ADD COLUMN external_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN external_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN library_visible BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX tracks_external_source_uniq
    ON tracks (source, external_id)
    WHERE source <> 'local' AND external_id <> '' AND deleted_at IS NULL;

CREATE INDEX tracks_source_idx ON tracks(source);
CREATE INDEX tracks_library_visible_idx ON tracks(library_visible) WHERE library_visible = TRUE;
