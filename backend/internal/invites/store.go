package invites

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/uncut/lumen/internal/auth"
	"github.com/uncut/lumen/internal/models"
)

var (
	ErrNotFound  = errors.New("invite not found")
	ErrExhausted = errors.New("invite no longer usable")
)

type Store struct {
	db *pgxpool.Pool
}

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

type CreateParams struct {
	CreatedBy  uuid.UUID
	TargetRole models.Role
	MaxUses    int
	ExpiresAt  *time.Time
}

type Created struct {
	Invite *models.Invite
	Token  string // plaintext, shown once
}

func (s *Store) Create(ctx context.Context, p CreateParams) (Created, error) {
	if p.MaxUses <= 0 {
		p.MaxUses = 1
	}
	if p.TargetRole == "" {
		p.TargetRole = models.RoleUser
	}
	plain, hash, err := auth.RandomToken(32)
	if err != nil {
		return Created{}, err
	}
	inv := &models.Invite{}
	err = s.db.QueryRow(ctx, `
		INSERT INTO invites (token_hash, created_by, target_role, max_uses, expires_at)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, token_hash, created_by, target_role, max_uses, uses, expires_at, revoked_at, created_at`,
		hash, p.CreatedBy, p.TargetRole, p.MaxUses, p.ExpiresAt,
	).Scan(&inv.ID, &inv.TokenHash, &inv.CreatedBy, &inv.TargetRole,
		&inv.MaxUses, &inv.Uses, &inv.ExpiresAt, &inv.RevokedAt, &inv.CreatedAt)
	if err != nil {
		return Created{}, err
	}
	return Created{Invite: inv, Token: plain}, nil
}

func (s *Store) LookupByToken(ctx context.Context, plain string) (*models.Invite, error) {
	hash := auth.HashToken(plain)
	inv := &models.Invite{}
	err := s.db.QueryRow(ctx, `
		SELECT id, token_hash, created_by, target_role, max_uses, uses, expires_at, revoked_at, created_at
		FROM invites WHERE token_hash = $1`, hash,
	).Scan(&inv.ID, &inv.TokenHash, &inv.CreatedBy, &inv.TargetRole,
		&inv.MaxUses, &inv.Uses, &inv.ExpiresAt, &inv.RevokedAt, &inv.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return inv, nil
}

// Consume atomically increments the use counter only if the invite is still usable.
// Returns the (still-locked) invite; caller should use it within the same transaction
// when creating the user.
func (s *Store) Consume(ctx context.Context, tx pgx.Tx, id uuid.UUID) (*models.Invite, error) {
	inv := &models.Invite{}
	err := tx.QueryRow(ctx, `
		UPDATE invites SET uses = uses + 1
		WHERE id = $1
		  AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > NOW())
		  AND uses < max_uses
		RETURNING id, token_hash, created_by, target_role, max_uses, uses, expires_at, revoked_at, created_at`,
		id,
	).Scan(&inv.ID, &inv.TokenHash, &inv.CreatedBy, &inv.TargetRole,
		&inv.MaxUses, &inv.Uses, &inv.ExpiresAt, &inv.RevokedAt, &inv.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrExhausted
		}
		return nil, err
	}
	return inv, nil
}

func (s *Store) Revoke(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.Exec(ctx, `UPDATE invites SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`, id)
	return err
}

type ListRow struct {
	Invite *models.Invite
	URL    string // populated by caller if it has the public base URL
}

func (s *Store) List(ctx context.Context) ([]*models.Invite, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, token_hash, created_by, target_role, max_uses, uses, expires_at, revoked_at, created_at
		FROM invites ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Invite
	for rows.Next() {
		inv := &models.Invite{}
		if err := rows.Scan(&inv.ID, &inv.TokenHash, &inv.CreatedBy, &inv.TargetRole,
			&inv.MaxUses, &inv.Uses, &inv.ExpiresAt, &inv.RevokedAt, &inv.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, inv)
	}
	return out, rows.Err()
}
