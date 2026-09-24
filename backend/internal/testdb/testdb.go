// Package testdb gives DB-backed test packages their own database. `go test
// ./...` runs packages in parallel against the one database named by
// LUMEN_REVIEW_TEST_DATABASE_URL, so rows one package inserts (shared
// library tracks, settings) show up in another package's counts.
package testdb

import (
	"context"
	"errors"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Sibling creates (if missing) a database next to the one base points at,
// named with suffix, and returns its URL. It fails when the role can't
// create databases; callers then fall back to base.
func Sibling(ctx context.Context, base, suffix string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	name := strings.TrimPrefix(u.Path, "/") + suffix
	conn, err := pgx.Connect(ctx, base)
	if err != nil {
		return "", err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	var pgErr *pgconn.PgError
	if err != nil && !(errors.As(err, &pgErr) && pgErr.Code == "42P04") { // duplicate_database
		return "", err
	}
	u.Path = "/" + name
	return u.String(), nil
}
