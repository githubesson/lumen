// Package musicroots manages additional music directories beyond the primary
// MUSIC_PATH. Rows here are read-only scan/watch locations; uploads and cover
// storage still go through the primary root.
package musicroots

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("music root not found")

type Root struct {
	ID        uuid.UUID `json:"id"`
	Path      string    `json:"path"`
	Label     string    `json:"label"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
}

type Store struct {
	db *pgxpool.Pool
}

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

func (s *Store) List(ctx context.Context) ([]Root, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, path, label, enabled, created_at
		FROM music_roots ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Root{}
	for rows.Next() {
		var r Root
		if err := rows.Scan(&r.ID, &r.Path, &r.Label, &r.Enabled, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// EnabledPaths returns just the paths of enabled rows. Used to extend the
// primary root when scanning/watching.
func (s *Store) EnabledPaths(ctx context.Context) ([]string, error) {
	rows, err := s.db.Query(ctx, `SELECT path FROM music_roots WHERE enabled = TRUE ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) Add(ctx context.Context, path, label string) (Root, error) {
	var r Root
	err := s.db.QueryRow(ctx, `
		INSERT INTO music_roots (path, label) VALUES ($1, $2)
		RETURNING id, path, label, enabled, created_at`, path, label).
		Scan(&r.ID, &r.Path, &r.Label, &r.Enabled, &r.CreatedAt)
	return r, err
}

func (s *Store) Delete(ctx context.Context, id uuid.UUID) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM music_roots WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Get returns a single root by id. Used before deletion so callers can cascade
// cleanup (e.g. soft-deleting tracks under the path).
func (s *Store) Get(ctx context.Context, id uuid.UUID) (Root, error) {
	var r Root
	err := s.db.QueryRow(ctx, `
		SELECT id, path, label, enabled, created_at FROM music_roots WHERE id = $1`, id).
		Scan(&r.ID, &r.Path, &r.Label, &r.Enabled, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Root{}, ErrNotFound
	}
	return r, err
}

func (s *Store) SetEnabled(ctx context.Context, id uuid.UUID, enabled bool) (Root, error) {
	var r Root
	err := s.db.QueryRow(ctx, `
		UPDATE music_roots SET enabled = $2 WHERE id = $1
		RETURNING id, path, label, enabled, created_at`, id, enabled).
		Scan(&r.ID, &r.Path, &r.Label, &r.Enabled, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Root{}, ErrNotFound
	}
	return r, err
}
