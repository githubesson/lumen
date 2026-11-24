package auth

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/dbutil"
	"github.com/githubesson/lumen/internal/models"
)

// APIKeyPrefix starts every API key. The auth middleware only treats bearer
// tokens with it as keys, so a proxy in front that adds its own bearer token
// doesn't lock everyone out, and secret scanners can spot a leaked key.
const APIKeyPrefix = "lumen_"

// MaxAPIKeysPerUser caps one user's keys, expired ones included.
const MaxAPIKeysPerUser = 25

// apiKeyShownChars is how much of the random part the prefix column keeps:
// enough to tell keys apart, 36 of the 256 bits.
const apiKeyShownChars = 6

// maxAPIKeyLen bounds what a lookup hashes; real keys are 49 characters.
const maxAPIKeyLen = 128

var (
	ErrAPIKeyNotFound = errors.New("api key not found")
	ErrTooManyAPIKeys = errors.New("too many api keys")
)

// APIKey is a key as its owner sees it: never the key itself, which is
// shown once, when it's made.
type APIKey struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
}

type APIKeyStore struct {
	db *pgxpool.Pool
}

func NewAPIKeyStore(db *pgxpool.Pool) *APIKeyStore {
	return &APIKeyStore{db: db}
}

// Create makes a key for userID and returns it in full, the only time it's
// available. expiresAt nil makes a key that lasts until it's deleted.
func (s *APIKeyStore) Create(ctx context.Context, userID uuid.UUID, name string, expiresAt *time.Time) (plain string, key APIKey, err error) {
	secret, _, err := RandomToken(32)
	if err != nil {
		return "", APIKey{}, err
	}
	plain = APIKeyPrefix + secret
	key = APIKey{
		Name:      name,
		Prefix:    plain[:len(APIKeyPrefix)+apiKeyShownChars],
		ExpiresAt: expiresAt,
	}
	err = dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		// Serializes one user's creates, so two at once can't both pass the
		// cap. A user deleted meanwhile has no row to lock.
		var count int
		err := tx.QueryRow(ctx, `
			SELECT (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id)
			FROM users u WHERE u.id = $1
			FOR NO KEY UPDATE OF u`, userID,
		).Scan(&count)
		if err != nil {
			return err
		}
		if count >= MaxAPIKeysPerUser {
			return ErrTooManyAPIKeys
		}
		return tx.QueryRow(ctx, `
			INSERT INTO api_keys (user_id, name, token_hash, prefix, expires_at)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, created_at`,
			userID, name, HashToken(plain), key.Prefix, expiresAt,
		).Scan(&key.ID, &key.CreatedAt)
	})
	if err != nil {
		return "", APIKey{}, err
	}
	return plain, key, nil
}

// List returns userID's keys, newest first, expired ones included.
func (s *APIKeyStore) List(ctx context.Context, userID uuid.UUID) ([]APIKey, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, name, prefix, created_at, last_used_at, expires_at
		FROM api_keys WHERE user_id = $1
		ORDER BY created_at DESC, id`, userID)
	if err != nil {
		return nil, err
	}
	keys, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (APIKey, error) {
		var k APIKey
		err := row.Scan(&k.ID, &k.Name, &k.Prefix, &k.CreatedAt, &k.LastUsedAt, &k.ExpiresAt)
		return k, err
	})
	if err != nil {
		return nil, err
	}
	return keys, nil
}

// Delete revokes one of userID's keys. Another user's key is ErrAPIKeyNotFound.
func (s *APIKeyStore) Delete(ctx context.Context, userID, id uuid.UUID) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM api_keys WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAPIKeyNotFound
	}
	return nil
}

// LookupUser authenticates a key and returns its id and user in one round
// trip, noting when it was last used at most once a minute.
func (s *APIKeyStore) LookupUser(ctx context.Context, plain string) (uuid.UUID, *models.User, error) {
	if len(plain) > maxAPIKeyLen {
		return uuid.Nil, nil, ErrAPIKeyNotFound
	}
	var (
		id   uuid.UUID
		u    models.User
		role string
	)
	err := s.db.QueryRow(ctx, `
		WITH valid_key AS MATERIALIZED (
			SELECT id, user_id
			FROM api_keys
			WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > NOW())
		), touch AS (
			UPDATE api_keys
			SET last_used_at = NOW()
			WHERE id = (SELECT id FROM valid_key)
			  AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')
		)
		SELECT k.id, `+userColumns+`
		FROM valid_key k
		JOIN users u ON u.id = k.user_id`, HashToken(plain),
	).Scan(append([]any{&id}, userScanTargets(&u, &role)...)...)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, nil, ErrAPIKeyNotFound
		}
		return uuid.Nil, nil, err
	}
	u.Role = models.Role(role)
	return id, &u, nil
}
