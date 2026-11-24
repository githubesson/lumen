-- API keys let scripts and other programs call the API as the user who made
-- them, with `Authorization: Bearer lumen_…`. Only the key's SHA-256 is kept;
-- prefix is its first few characters, shown so keys can be told apart. A key
-- with no expires_at lasts until it's deleted. Changing the password or
-- disabling the user deletes their keys, as it does their sessions.
CREATE TABLE api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    token_hash   BYTEA NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    expires_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);
CREATE INDEX api_keys_user_id_idx ON api_keys(user_id);
