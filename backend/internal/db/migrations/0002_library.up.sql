CREATE TABLE artists (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    sort_name       TEXT,
    musicbrainz_id  UUID,
    bio             TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (name)
);
CREATE INDEX artists_name_trgm ON artists USING gin (name gin_trgm_ops);

CREATE TABLE albums (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    album_artist_id UUID REFERENCES artists(id) ON DELETE SET NULL,
    is_compilation  BOOLEAN NOT NULL DEFAULT FALSE,
    release_year    INTEGER,
    release_type    TEXT,
    musicbrainz_id  UUID,
    cover_art_path  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX albums_artist_idx ON albums(album_artist_id);
CREATE INDEX albums_title_trgm ON albums USING gin (title gin_trgm_ops);

CREATE TABLE tracks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    album_id        UUID REFERENCES albums(id) ON DELETE SET NULL,
    title           TEXT NOT NULL,
    track_no        INTEGER,
    disc_no         INTEGER,
    duration_ms     INTEGER NOT NULL,
    genre           TEXT,
    year            INTEGER,
    composer        TEXT,
    bpm             INTEGER,
    isrc            TEXT,
    comments        TEXT,
    file_path       TEXT NOT NULL,
    file_size       BIGINT NOT NULL,
    format          TEXT NOT NULL,
    bitrate         INTEGER,
    sample_rate     INTEGER,
    channels        SMALLINT,
    replay_gain_track REAL,
    replay_gain_album REAL,
    audio_sha256    BYTEA NOT NULL UNIQUE,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tracks_album_idx ON tracks(album_id);
CREATE INDEX tracks_title_trgm ON tracks USING gin (title gin_trgm_ops);
CREATE INDEX tracks_deleted_idx ON tracks(deleted_at);

CREATE TABLE track_artists (
    track_id        UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    artist_id       UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'featured', 'composer', 'remixer')),
    position        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (track_id, artist_id, role)
);

CREATE TABLE playlists (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name            TEXT NOT NULL,
    description     TEXT,
    visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'collaborative')),
    is_smart        BOOLEAN NOT NULL DEFAULT FALSE,
    smart_rules     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX playlists_owner_idx ON playlists(owner_id);

CREATE TABLE playlist_tracks (
    playlist_id     UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    track_id        UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    added_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (playlist_id, position)
);
CREATE INDEX playlist_tracks_track_idx ON playlist_tracks(track_id);

CREATE TABLE playlist_collaborators (
    playlist_id     UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
    invited_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at     TIMESTAMPTZ,
    PRIMARY KEY (playlist_id, user_id)
);
CREATE INDEX playlist_collab_user_idx ON playlist_collaborators(user_id);

CREATE TABLE playlist_share_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    playlist_id     UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    token_hash      BYTEA NOT NULL UNIQUE,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX playlist_share_playlist_idx ON playlist_share_links(playlist_id);

CREATE TABLE user_track_stats (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id        UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    play_count      INTEGER NOT NULL DEFAULT 0,
    last_played_at  TIMESTAMPTZ,
    rating          SMALLINT CHECK (rating BETWEEN 0 AND 5),
    favorited       BOOLEAN NOT NULL DEFAULT FALSE,
    favorited_at    TIMESTAMPTZ,
    PRIMARY KEY (user_id, track_id)
);
CREATE INDEX user_track_stats_fav_idx ON user_track_stats(user_id) WHERE favorited;

CREATE TABLE play_history (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id        UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    played_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completion      REAL
);
CREATE INDEX play_history_user_time_idx ON play_history(user_id, played_at DESC);

CREATE TABLE ingest_errors (
    id              BIGSERIAL PRIMARY KEY,
    file_path       TEXT NOT NULL,
    error           TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE settings (
    key             TEXT PRIMARY KEY,
    value           JSONB NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
