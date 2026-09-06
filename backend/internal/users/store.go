package users

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

var ErrNotFound = errors.New("user not found")

type Store struct {
	db *pgxpool.Pool
}

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

func (s *Store) ByUsername(ctx context.Context, username string) (*models.User, error) {
	row := s.db.QueryRow(ctx, `
		SELECT id, username, password_hash, role, disabled, must_reset_password,
		       invite_id, last_login_at, created_at, updated_at
		FROM users WHERE username = $1`, username)
	return scanUser(row)
}

func (s *Store) ByID(ctx context.Context, id uuid.UUID) (*models.User, error) {
	row := s.db.QueryRow(ctx, `
		SELECT id, username, password_hash, role, disabled, must_reset_password,
		       invite_id, last_login_at, created_at, updated_at
		FROM users WHERE id = $1`, id)
	return scanUser(row)
}

type CreateParams struct {
	Username          string
	PasswordHash      string
	Role              models.Role
	InviteID          *uuid.UUID
	MustResetPassword bool
}

func (s *Store) Create(ctx context.Context, p CreateParams) (*models.User, error) {
	row := s.db.QueryRow(ctx, `
		INSERT INTO users (username, password_hash, role, invite_id, must_reset_password)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, username, password_hash, role, disabled, must_reset_password,
		          invite_id, last_login_at, created_at, updated_at`,
		p.Username, p.PasswordHash, p.Role, p.InviteID, p.MustResetPassword)
	return scanUser(row)
}

// ChangePassword atomically replaces the verified password and revokes sessions.
// The old hash condition prevents a concurrent reset using a stale verification.
func (s *Store) ChangePassword(ctx context.Context, id uuid.UUID, oldHash, newHash string) error {
	return dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE users SET password_hash = $3,
    must_reset_password = FALSE, updated_at = NOW()
    WHERE id = $1 AND password_hash = $2`, id, oldHash, newHash)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return ErrNotFound
		}
		_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, id)
		return err
	})
}

func (s *Store) TouchLogin(ctx context.Context, id uuid.UUID, now time.Time) error {
	_, err := s.db.Exec(ctx, `UPDATE users SET last_login_at = $2 WHERE id = $1`, id, now)
	return err
}

func (s *Store) Count(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

type scanner interface {
	Scan(dst ...any) error
}

func scanUser(row scanner) (*models.User, error) {
	var u models.User
	var role string
	if err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &role, &u.Disabled,
		&u.MustResetPassword, &u.InviteID, &u.LastLoginAt, &u.CreatedAt, &u.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	u.Role = models.Role(role)
	return &u, nil
}
