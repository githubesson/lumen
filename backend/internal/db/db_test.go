package db

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestConcurrentMigrateBuildsIndexesWithoutDeadlocks(t *testing.T) {
	base := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if base == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close(context.Background()) })
	name := "lumen_migration_" + uuid.NewString()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.Exec(cleanupCtx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Errorf("drop migration test database: %v", err)
		}
	})
	target, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	target.Path, target.RawPath = "/"+name, ""
	migrationURL := target.String()
	const starters = 8
	start, results := make(chan struct{}), make(chan error, starters)
	for range starters {
		go func() {
			<-start
			results <- Migrate(migrationURL)
		}()
	}
	close(start)
	for range starters {
		select {
		case err := <-results:
			if err != nil {
				t.Errorf("concurrent migration: %v", err)
			}
		case <-ctx.Done():
			t.Fatal("concurrent migrations did not finish: ", ctx.Err())
		}
	}
	conn, err := pgx.Connect(ctx, migrationURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var valid int
	if err := conn.QueryRow(ctx, `
		SELECT COUNT(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
		WHERE i.indisvalid AND c.relname = ANY($1::text[])`, []string{
		"track_artists_artist_track_idx", "tracks_visible_recent_idx",
		"tracks_visible_title_idx", "tracks_visible_duration_idx", "user_track_stats_recent_idx",
	}).Scan(&valid); err != nil || valid != 5 {
		t.Fatalf("valid concurrent indexes = %d, want 5: %v", valid, err)
	}
}
