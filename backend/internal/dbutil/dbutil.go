// Package dbutil centralizes small Postgres/pgx helpers that were previously
// copy-pasted across store packages: transaction wrapping, NULL marshaling for
// nullable columns, scanning pgtype values back into Go pointers, and reliable
// unique-violation detection.
package dbutil

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// uniqueViolation is the Postgres SQLSTATE for a unique-constraint violation.
const uniqueViolation = "23505"

// WithTx runs fn inside a transaction. It commits when fn returns nil and rolls
// back otherwise; the deferred rollback is a no-op once Commit has succeeded.
// The pgx.Tx passed to fn is only valid for the duration of the call.
func WithTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// IsUniqueViolation reports whether err (or anything it wraps) is a Postgres
// unique-constraint violation. This inspects the SQLSTATE code rather than the
// human-readable message, which is locale- and version-dependent.
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == uniqueViolation
}

// SetBuilder accumulates "column = $N" assignments and their argument values
// for a dynamic UPDATE statement. Positional placeholders are numbered from 1
// in the order Add is called, so the caller can append a trailing key (e.g. the
// WHERE id) to the returned args and use len(args) for its placeholder.
//
// The zero value is ready to use.
type SetBuilder struct {
	sets []string
	args []any
}

// Add appends a value-bearing assignment. fragment must contain a single %d for
// the positional placeholder, e.g. b.Add("label = $%d", label).
func (b *SetBuilder) Add(fragment string, value any) {
	b.args = append(b.args, value)
	b.sets = append(b.sets, fmt.Sprintf(fragment, len(b.args)))
}

// AddRaw appends an assignment that takes no argument, e.g.
// b.AddRaw("updated_at = NOW()") or b.AddRaw("album_id = NULL").
func (b *SetBuilder) AddRaw(fragment string) {
	b.sets = append(b.sets, fragment)
}

// Count reports the total number of assignments added (both value-bearing and
// raw). Callers use this to decide whether anything beyond a seeded
// "updated_at = NOW()" was set.
func (b *SetBuilder) Count() int { return len(b.sets) }

// Build returns the comma-joined SET clause and the accumulated args.
func (b *SetBuilder) Build() (string, []any) {
	return strings.Join(b.sets, ", "), b.args
}

// NullableUUID returns *id for binding as a query argument, or nil so the driver
// writes SQL NULL when id is nil.
func NullableUUID(id *uuid.UUID) any {
	if id == nil {
		return nil
	}
	return *id
}

// UUIDPtr converts a scanned pgtype.UUID into a *uuid.UUID (nil when NULL).
func UUIDPtr(v pgtype.UUID) *uuid.UUID {
	if !v.Valid {
		return nil
	}
	id := uuid.UUID(v.Bytes)
	return &id
}

// TimePtr converts a scanned pgtype.Timestamptz into a *time.Time (nil when NULL).
func TimePtr(v pgtype.Timestamptz) *time.Time {
	if !v.Valid {
		return nil
	}
	t := v.Time
	return &t
}
