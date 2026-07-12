package lastfm

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotConnected = errors.New("last.fm is not connected")
var ErrIneligible = errors.New("track has not reached the Last.fm scrobble threshold")

type Connection struct {
	Username     string
	SessionKey   string
	PendingToken string
	PendingUntil *time.Time
	ConnectedAt  *time.Time
	LastError    string
}

type Store struct{ db *pgxpool.Pool }

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

func (s *Store) Get(ctx context.Context, userID uuid.UUID) (*Connection, error) {
	var c Connection
	err := s.db.QueryRow(ctx, `
		SELECT COALESCE(username, ''), COALESCE(session_key, ''),
		       COALESCE(pending_token, ''), pending_expires_at,
		       connected_at, COALESCE(last_error, '')
		FROM lastfm_connections WHERE user_id = $1`, userID).Scan(
		&c.Username, &c.SessionKey, &c.PendingToken, &c.PendingUntil,
		&c.ConnectedAt, &c.LastError,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotConnected
	}
	return &c, err
}

func (s *Store) Begin(ctx context.Context, userID uuid.UUID, token string, expiresAt time.Time) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO lastfm_connections (user_id, pending_token, pending_expires_at, last_error)
		VALUES ($1, $2, $3, NULL)
		ON CONFLICT (user_id) DO UPDATE SET
			pending_token = EXCLUDED.pending_token,
			pending_expires_at = EXCLUDED.pending_expires_at,
			last_error = NULL,
			updated_at = NOW()`, userID, token, expiresAt)
	return err
}

func (s *Store) Complete(ctx context.Context, userID uuid.UUID, session Session) error {
	_, err := s.db.Exec(ctx, `
		UPDATE lastfm_connections SET
			username = $2, session_key = $3,
			pending_token = NULL, pending_expires_at = NULL,
			connected_at = NOW(), last_error = NULL, updated_at = NOW()
		WHERE user_id = $1`, userID, session.Username, session.Key)
	return err
}

func (s *Store) Disconnect(ctx context.Context, userID uuid.UUID) error {
	_, err := s.db.Exec(ctx, `DELETE FROM lastfm_connections WHERE user_id = $1`, userID)
	return err
}

func (s *Store) SetError(ctx context.Context, userID uuid.UUID, message string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE lastfm_connections SET last_error = $2, updated_at = NOW()
		WHERE user_id = $1`, userID, message)
	return err
}

func (s *Store) InvalidateSession(ctx context.Context, userID uuid.UUID, message string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE lastfm_connections SET session_key = NULL, connected_at = NULL,
			last_error = $2, updated_at = NOW()
		WHERE user_id = $1`, userID, message)
	return err
}
