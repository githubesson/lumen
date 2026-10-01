-- Local library tracks looked up on TIDAL so they can be filed by TIDAL's
-- metadata, as saved downloads are. One row per track once it has been
-- tried: 'matched' tracks took TIDAL's metadata and are never looked up
-- again; 'unmatched' ones had no confident match and are retried after a
-- long while; 'failed' ones hit an error and back off.
CREATE TABLE tidal_matches (
    track_id        UUID PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    status          TEXT NOT NULL CHECK (status IN ('matched', 'unmatched', 'failed')),
    tidal_id        TEXT NOT NULL DEFAULT '',
    -- The release the track was filed under: set for matches, and for
    -- unmatched tracks moved along with the rest of their album.
    tidal_album_id  TEXT NOT NULL DEFAULT '',
    error           TEXT NOT NULL DEFAULT '',
    attempts        INTEGER NOT NULL DEFAULT 0,
    -- NULL never retries (matched).
    next_attempt_at TIMESTAMPTZ,
    -- A match's release cover, while its album still needs artwork; cleared
    -- once the album has some. Failed fetches retry from cover_retry_at.
    cover_url       TEXT NOT NULL DEFAULT '',
    cover_retry_at  TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tidal_matches_cover_idx ON tidal_matches(cover_retry_at) WHERE cover_url <> '';
