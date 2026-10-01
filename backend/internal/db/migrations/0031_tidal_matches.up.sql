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
    -- The track's album's TIDAL link and the track's updated_at when the
    -- outcome was recorded. Either changing since (a link made by
    -- auto-download, a duplicate's tags adopted) makes it due again; an
    -- exact copy, not an ordering, as NOW() is a transaction's start.
    album_link      TEXT NOT NULL DEFAULT '',
    track_version   TIMESTAMPTZ,
    -- Consecutive failures, for the backoff; 0 after any other outcome.
    attempts        INTEGER NOT NULL DEFAULT 0,
    -- NULL never retries (matched).
    next_attempt_at TIMESTAMPTZ,
    -- A match's release cover and the album it filed the track under, while
    -- that album still needs artwork; cleared once it has some. Failed
    -- fetches retry from cover_retry_at.
    cover_url       TEXT NOT NULL DEFAULT '',
    cover_album_id  UUID REFERENCES albums(id) ON DELETE SET NULL,
    cover_retry_at  TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tidal_matches_cover_idx ON tidal_matches(cover_retry_at) WHERE cover_url <> '';

-- The release chosen for a library album while its tracks are being filed
-- under it, so an attempt cut short finishes on the same release rather than
-- judging the tracks left on their own. Removed once every track is done.
CREATE TABLE tidal_match_albums (
    album_id       UUID PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
    tidal_album_id TEXT NOT NULL,
    -- The tracks the choice was judged on; only they finish under it.
    track_ids      UUID[] NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Matching skips tracks an importer brought in, per track; API tracker
-- downloads already have this index.
CREATE INDEX IF NOT EXISTS artistgrid_downloads_track_idx ON artistgrid_downloads(track_id);

-- Set when an admin edits an album's title, album artist, year or
-- compilation flag. TIDAL matching leaves the tracks of such an album alone,
-- so it never refiles them under TIDAL's album.
ALTER TABLE albums ADD COLUMN metadata_edited_at TIMESTAMPTZ;
