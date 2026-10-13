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

// userColumns is what scanUser reads, in its order.
const userColumns = `id, username, password_hash, role, disabled, must_reset_password,
	invite_id, last_login_at, created_at, updated_at`

func (s *Store) ByUsername(ctx context.Context, username string) (*models.User, error) {
	return scanUser(s.db.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE username = $1`, username))
}

func (s *Store) ByID(ctx context.Context, id uuid.UUID) (*models.User, error) {
	return scanUser(s.db.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, id))
}

// List returns every user, oldest first.
func (s *Store) List(ctx context.Context) ([]*models.User, error) {
	rows, err := s.db.Query(ctx, `SELECT `+userColumns+` FROM users ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	// A connection reset or statement timeout mid-iteration must not pass
	// for a shorter list.
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

type CreateParams struct {
	Username          string
	PasswordHash      string
	Role              models.Role
	InviteID          *uuid.UUID
	MustResetPassword bool
}

func (s *Store) Create(ctx context.Context, p CreateParams) (*models.User, error) {
	return create(ctx, s.db, p)
}

// CreateTx is Create inside tx, such as the one registration consumes its
// invite in.
func (s *Store) CreateTx(ctx context.Context, tx pgx.Tx, p CreateParams) (*models.User, error) {
	return create(ctx, tx, p)
}

// rowQuerier is a pool or a transaction.
type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func create(ctx context.Context, q rowQuerier, p CreateParams) (*models.User, error) {
	return scanUser(q.QueryRow(ctx, `
		INSERT INTO users (username, password_hash, role, invite_id, must_reset_password)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING `+userColumns,
		p.Username, p.PasswordHash, p.Role, p.InviteID, p.MustResetPassword))
}

// Enable lets a disabled user sign in again. It returns ErrNotFound when
// there is no such user.
func (s *Store) Enable(ctx context.Context, id uuid.UUID) error {
	tag, err := s.db.Exec(ctx, `UPDATE users SET disabled = FALSE, updated_at = NOW() WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DisableTx disables a user and revokes their sessions inside tx, the one
// the caller checks there is another admin in. It returns ErrNotFound when
// there is no such user.
func (s *Store) DisableTx(ctx context.Context, tx pgx.Tx, id uuid.UUID) error {
	tag, err := tx.Exec(ctx, `UPDATE users SET disabled = TRUE, updated_at = NOW() WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, id)
	return err
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
