-- Full TIDAL album metadata, cached when a track from the album is saved (or
-- its TIDAL page is viewed), so a library album built from a few saved tracks
-- can still show the whole release without calling TIDAL on every view.
CREATE TABLE tidal_albums (
    tidal_id     TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    artist       TEXT NOT NULL DEFAULT '',
    artists      JSONB NOT NULL DEFAULT '[]'::jsonb,
    release_year INTEGER NOT NULL DEFAULT 0,
    cover_id     TEXT NOT NULL DEFAULT '',
    cover_url    TEXT NOT NULL DEFAULT '',
    track_count  INTEGER NOT NULL DEFAULT 0,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    -- The ordered track list: [{id, title, track_no, disc_no, duration_ms,
    -- artists, isrc}, ...].
    tracks       JSONB NOT NULL DEFAULT '[]'::jsonb,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The TIDAL release a library album is a (partial) copy of. Its page then
-- shows the full TIDAL track list with saved tracks swapped in.
ALTER TABLE albums ADD COLUMN tidal_album_id TEXT;
CREATE INDEX albums_tidal_album_idx ON albums(tidal_album_id) WHERE tidal_album_id IS NOT NULL;

-- The TIDAL album a saved track belongs to: '' until known ('-' when TIDAL
-- lists none). Downloads from before album metadata was applied start at ''
-- and are backfilled by the worker.
ALTER TABLE tidal_downloads ADD COLUMN tidal_album_id TEXT NOT NULL DEFAULT '';

-- Tracks an admin asked to save outright (e.g. "download album"), apart
-- from any playlist. One-shot: the worker deletes a request once the track
-- is saved, so deleting the file later doesn't bring it back.
CREATE TABLE tidal_download_requests (
    tidal_id       TEXT PRIMARY KEY,
    tidal_album_id TEXT NOT NULL DEFAULT '',
    requested_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tidal_download_requests_album_idx ON tidal_download_requests(tidal_album_id);
