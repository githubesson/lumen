// Package musicroots manages additional music directories beyond the primary
// MUSIC_PATH. Rows here are read-only scan/watch locations; uploads and cover
// storage still go through the primary root.
package musicroots

import (
	"context"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/dbutil"
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

	// Held by cache loads, and by root writes to clear the snapshot once they
	// commit, so a load that read the rows before a write can't outlive it.
	// Nil means not loaded.
	pathsMu      sync.Mutex
	enabledPaths []string
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
// primary root when scanning/watching and validating playback paths. The
// process-local snapshot is invalidated by every root mutation in this store.
func (s *Store) EnabledPaths(ctx context.Context) ([]string, error) {
	s.pathsMu.Lock()
	defer s.pathsMu.Unlock()
	if s.enabledPaths != nil {
		return slices.Clone(s.enabledPaths), nil
	}
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	s.enabledPaths = out
	return slices.Clone(out), nil
}

func (s *Store) Add(ctx context.Context, path, label string) (Root, error) {
	var r Root
	err := s.mutate(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO music_roots (path, label) VALUES ($1, $2)
			RETURNING id, path, label, enabled, created_at`, path, label).
			Scan(&r.ID, &r.Path, &r.Label, &r.Enabled, &r.CreatedAt)
	})
	return r, err
}

// topologyLock serializes changes to which roots exist and are enabled, so a
// removal's purge decides against a set of live roots nothing else changes
// before it commits.
const topologyLock int64 = 0x6c756d656e726f6f // "lumenroo"

// mutate runs fn in a transaction holding topologyLock, then drops the
// EnabledPaths snapshot. It's dropped after the commit rather than held
// across it, so a long purge doesn't stall every EnabledPaths reader: a load
// that ran before the commit and cached the old paths is cleared here, and
// loads take pathsMu, so none can republish them afterwards.
func (s *Store) mutate(ctx context.Context, fn func(pgx.Tx) error) error {
	err := dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, topologyLock); err != nil {
			return err
		}
		return fn(tx)
	})
	s.pathsMu.Lock()
	s.enabledPaths = nil
	s.pathsMu.Unlock()
	return err
}

func (s *Store) Delete(ctx context.Context, id uuid.UUID) error {
	return s.DeleteWith(ctx, id, nil)
}

// DeleteWith deletes a root and runs also (purging its tracks, say) in the
// same transaction, so neither happens without the other. also gets the
// transaction and every other root, read under topologyLock: no root can be
// added, enabled, disabled or removed until this commits.
func (s *Store) DeleteWith(ctx context.Context, id uuid.UUID, also func(tx pgx.Tx, others []Root) error) error {
	return s.mutate(ctx, func(tx pgx.Tx) error {
		if also != nil {
			rows, err := tx.Query(ctx, `
				SELECT id, path, label, enabled, created_at
				FROM music_roots WHERE id <> $1 ORDER BY created_at ASC`, id)
			if err != nil {
				return err
			}
			others, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Root, error) {
				var r Root
				err := row.Scan(&r.ID, &r.Path, &r.Label, &r.Enabled, &r.CreatedAt)
				return r, err
			})
			if err != nil {
				return err
			}
			if err := also(tx, others); err != nil {
				return err
			}
		}
		tag, err := tx.Exec(ctx, `DELETE FROM music_roots WHERE id = $1`, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
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
	err := s.mutate(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			UPDATE music_roots SET enabled = $2 WHERE id = $1
			RETURNING id, path, label, enabled, created_at`, id, enabled).
			Scan(&r.ID, &r.Path, &r.Label, &r.Enabled, &r.CreatedAt)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Root{}, ErrNotFound
	}
	return r, err
}
