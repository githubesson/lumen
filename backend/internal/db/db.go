package db

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse db url: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

func Migrate(url string) error {
	// A blocking advisory-lock query can hold a transaction snapshot that
	// CREATE INDEX CONCURRENTLY waits for, deadlocking simultaneous starters.
	// Poll a separate session lock before opening migrate's driver so waiting
	// processes leave no statement or transaction open between attempts.
	gate, err := pgx.Connect(context.Background(), url)
	if err != nil {
		return fmt.Errorf("migration gate connect: %w", err)
	}
	defer gate.Close(context.Background()) // closing releases the session lock
	for {
		var locked bool
		// The two-int namespace is distinct from migrate's bigint lock key.
		if err := gate.QueryRow(context.Background(), `SELECT pg_try_advisory_lock($1, $2)`,
			int32(0x6c756d6e), int32(1)).Scan(&locked); err != nil {
			return fmt.Errorf("migration gate lock: %w", err)
		}
		if locked {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	src, err := iofs.New(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("iofs: %w", err)
	}
	// The pgx/v5 migrate driver registers itself under the `pgx5` scheme.
	// Everyone else in the codebase uses `postgres://` — rewrite just for migrate.
	migrateURL := url
	if strings.HasPrefix(migrateURL, "postgres://") {
		migrateURL = "pgx5://" + strings.TrimPrefix(migrateURL, "postgres://")
	} else if strings.HasPrefix(migrateURL, "postgresql://") {
		migrateURL = "pgx5://" + strings.TrimPrefix(migrateURL, "postgresql://")
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, migrateURL)
	if err != nil {
		return fmt.Errorf("migrate init: %w", err)
	}
	defer m.Close()
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migrate up: %w", err)
	}
	return nil
}
