package handlers

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/google/uuid"
)

// A cancelled upload leaves nothing behind: the tracks its request added go,
// with their files in the upload's folder, and nothing outside it is touched.
func TestUndoCancelledUploadRemovesWhatItAdded(t *testing.T) {
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
	defer pool.Close()
	user := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role) VALUES($1,$2,'test','user')`, user, "cancel-"+user.String()); err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, user)
	lib := library.NewStore(pool)

	destDir := t.TempDir()
	elsewhere := filepath.Join(t.TempDir(), "keep.mp3")
	track := func(path string) uuid.UUID {
		if err := os.WriteFile(path, []byte(path), 0o644); err != nil {
			t.Fatal(err)
		}
		sha := sha256.Sum256([]byte(path))
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		id, _, _, err := library.InsertTrack(ctx, tx, library.TrackInsert{
			OwnerID: &user, Title: filepath.Base(path), DurationMS: 1000,
			FilePath: path, FileSize: 1, Format: "mp3", AudioSHA256: sha[:],
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		return id
	}
	added := track(filepath.Join(destDir, "added.mp3"))
	other := track(elsewhere) // the user's, but not from this upload
	defer pool.Exec(ctx, `DELETE FROM tracks WHERE id=$1`, other)

	h := &Library{Library: lib}
	h.undoCancelledUpload(ctx, user, &user, destDir, []uuid.UUID{added})

	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM tracks WHERE id=$1`, added).Scan(&n); err != nil || n != 0 {
		t.Fatalf("added track still there (count %d, err %v)", n, err)
	}
	if _, err := os.Stat(filepath.Join(destDir, "added.mp3")); !os.IsNotExist(err) {
		t.Fatalf("added file still on disk: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM tracks WHERE id=$1`, other).Scan(&n); err != nil || n != 1 {
		t.Fatalf("an unrelated track was removed (count %d, err %v)", n, err)
	}
	if _, err := os.Stat(elsewhere); err != nil {
		t.Fatalf("a file outside the upload folder was removed: %v", err)
	}
}

// Only new tracks are taken back: a promotion took over a user's existing
// personal track, and a dedup hit or a failure added nothing.
func TestAddedByUpload(t *testing.T) {
	id := uuid.New()
	cases := []struct {
		name string
		res  ingest.Outcome
		want bool
	}{
		{"new track", ingest.Outcome{TrackID: id, Inserted: true}, true},
		{"promoted personal track", ingest.Outcome{TrackID: id, Inserted: true, Promoted: true}, false},
		{"dedup hit", ingest.Outcome{TrackID: id}, false},
		{"failed", ingest.Outcome{TrackID: id, Inserted: true, Err: errors.New("boom")}, false},
		{"no track", ingest.Outcome{Inserted: true}, false},
	}
	for _, c := range cases {
		if got := addedByUpload(c.res); got != c.want {
			t.Errorf("%s: addedByUpload = %v, want %v", c.name, got, c.want)
		}
	}
}
