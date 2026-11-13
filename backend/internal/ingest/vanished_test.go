package ingest

import (
	"context"
	"crypto/sha256"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/library"
)

// A fresh track whose file went while it was being ingested (an upload
// cancelled under the watcher's re-ingest) is removed; one whose file is
// still there stays.
func TestDropIfVanished(t *testing.T) {
	url := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	if err := db.Migrate(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	user := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role) VALUES($1,$2,'test','user')`, user, "vanished-"+user.String()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user) })

	dir := t.TempDir()
	insert := func(path string) uuid.UUID {
		t.Helper()
		sha := sha256.Sum256([]byte(path))
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		id, _, _, err := library.InsertTrack(ctx, tx, library.TrackInsert{
			OwnerID: &user, Title: filepath.Base(path), DurationMS: 1000,
			FilePath: path, FileSize: 1, Format: "flac", AudioSHA256: sha[:],
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM tracks WHERE id=$1`, id) })
		return id
	}
	here := filepath.Join(dir, "here.flac")
	if err := os.WriteFile(here, []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	gone := filepath.Join(dir, "gone.flac") // removed before the check
	keptID, goneID := insert(here), insert(gone)

	svc := &Service{DB: pool, Library: library.NewStore(pool), Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if svc.dropIfVanished(ctx, here) {
		t.Fatal("dropped a track whose file is still there")
	}
	if !svc.dropIfVanished(ctx, gone) {
		t.Fatal("kept a track whose file is gone")
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM tracks WHERE id = ANY($1)`, []uuid.UUID{keptID, goneID}).Scan(&n); err != nil || n != 1 {
		t.Fatalf("tracks left = %d (%v), want only the one whose file is there", n, err)
	}
}
