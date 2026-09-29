package integration

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/httpapi/handlers"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Removing a folder with purge only drops tracks nothing watches any more:
// not those under a watched folder inside it, and none at all when a folder
// around it is still watched.
func TestRemoveRootPurgeKeepsWatchedTracks(t *testing.T) {
	url := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	if err := db.Migrate(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	primary, ext := t.TempDir(), t.TempDir()
	keepDir := filepath.Join(ext, "keep")
	nested := filepath.Join(primary, "artist")
	// The primary root's scan skips dot-directories, so this one is only
	// watched through its own root.
	hidden := filepath.Join(primary, ".archive")
	for _, d := range []string{keepDir, nested, hidden} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	tracks := map[string]uuid.UUID{}
	for _, p := range []string{
		filepath.Join(ext, "gone.mp3"),
		filepath.Join(ext, "dupe.mp3"),
		filepath.Join(keepDir, "kept.mp3"),
		filepath.Join(nested, "covered.mp3"),
		filepath.Join(hidden, "hidden.mp3"),
		filepath.Join(primary, "loose.mp3"),
		filepath.Join(ext, "ghost.mp3"),
	} {
		id := uuid.New()
		tracks[p] = id
		if _, err := pool.Exec(ctx, `INSERT INTO tracks(id,title,duration_ms,file_path,file_size,format,audio_sha256) VALUES($1,'t',1000,$2,1,'mp3',$3)`, id, p, id[:]); err != nil {
			t.Fatal(err)
		}
	}
	// dupe.mp3 has an identical copy in the still-watched ext/keep, recorded
	// as an alias of the same track.
	dupeCopy := filepath.Join(keepDir, "dupe-copy.mp3")
	if err := os.WriteFile(dupeCopy, []byte("audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO track_aliases(track_id, file_path) VALUES($1, $2)`,
		tracks[filepath.Join(ext, "dupe.mp3")], dupeCopy); err != nil {
		t.Fatal(err)
	}
	// ghost.mp3's alias under the primary root is metadata only: ingest
	// unlinked that duplicate, so it doesn't keep the track.
	if _, err := pool.Exec(ctx, `INSERT INTO track_aliases(track_id, file_path) VALUES($1, $2)`,
		tracks[filepath.Join(ext, "ghost.mp3")], filepath.Join(primary, "ghost-copy.mp3")); err != nil {
		t.Fatal(err)
	}
	// loose.mp3 is watched by the primary root; its copy in .archive isn't
	// the only one.
	if _, err := pool.Exec(ctx, `INSERT INTO track_aliases(track_id, file_path) VALUES($1, $2)`,
		tracks[filepath.Join(primary, "loose.mp3")], filepath.Join(hidden, "loose-copy.mp3")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ids := make([]uuid.UUID, 0, len(tracks))
		for _, id := range tracks {
			ids = append(ids, id)
		}
		_, _ = pool.Exec(context.Background(), `DELETE FROM tracks WHERE id = ANY($1)`, ids)
	})

	store := musicroots.NewStore(pool)
	var ids []uuid.UUID
	for _, p := range []string{ext, keepDir, nested, hidden} {
		row, err := store.Add(ctx, p, "")
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, row.ID)
	}
	t.Cleanup(func() {
		for _, id := range ids {
			_ = store.Delete(context.Background(), id)
		}
	})

	h := &handlers.AdminRoots{Store: store, Library: library.NewStore(pool), PrimaryRoot: primary}
	router := chi.NewRouter()
	router.Delete("/roots/{id}", h.Delete)
	remove := func(id uuid.UUID) {
		t.Helper()
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/roots/"+id.String()+"?purge=true", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("remove status = %d: %s", w.Code, w.Body.String())
		}
	}
	remove(ids[0]) // ext, which contains the still-watched ext/keep
	remove(ids[2]) // primary/artist, covered by the primary root

	deleted := func(path string) bool {
		var gone bool
		if err := pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM tracks WHERE id = $1`, tracks[path]).Scan(&gone); err != nil {
			t.Fatal(err)
		}
		return gone
	}
	if !deleted(filepath.Join(ext, "gone.mp3")) {
		t.Error("track only the removed folder watched was kept")
	}
	if deleted(filepath.Join(ext, "dupe.mp3")) {
		t.Error("track with a copy under a still-watched folder was purged")
	}
	// ...and that copy is now its file, since the old one isn't watched.
	var dupePath string
	var aliases int
	if err := pool.QueryRow(ctx, `SELECT file_path, (SELECT COUNT(*) FROM track_aliases WHERE track_id = t.id) FROM tracks t WHERE id = $1`,
		tracks[filepath.Join(ext, "dupe.mp3")]).Scan(&dupePath, &aliases); err != nil {
		t.Fatal(err)
	}
	if dupePath != dupeCopy || aliases != 0 {
		t.Errorf("kept track's file = %q with %d aliases; want the surviving copy %q promoted", dupePath, aliases, dupeCopy)
	}
	if !deleted(filepath.Join(ext, "ghost.mp3")) {
		t.Error("track kept for an alias whose file is gone")
	}
	if deleted(filepath.Join(keepDir, "kept.mp3")) {
		t.Error("track under a still-watched folder inside the removed one was purged")
	}
	if deleted(filepath.Join(nested, "covered.mp3")) {
		t.Error("track under a folder the primary root still covers was purged")
	}

	// A failed removal leaves both the root and its tracks as they were.
	boom := errors.New("boom")
	err = store.DeleteWith(ctx, ids[3], func(tx pgx.Tx, _ []musicroots.Root) error {
		if _, err := library.SoftDeleteRootTracks(ctx, tx, hidden+string(filepath.Separator), nil, []string{primary + string(filepath.Separator)}); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("DeleteWith err = %v, want boom", err)
	}
	if _, err := store.Get(ctx, ids[3]); err != nil {
		t.Fatalf("root gone after a failed removal: %v", err)
	}
	if deleted(filepath.Join(hidden, "hidden.mp3")) {
		t.Fatal("purge survived a failed removal")
	}

	// .archive isn't covered by the primary root (its scan skips dot-dirs),
	// so its tracks go, except one whose other copy the primary still scans.
	remove(ids[3])
	if !deleted(filepath.Join(hidden, "hidden.mp3")) {
		t.Error("track only the removed dot-dir root watched was kept")
	}
	if deleted(filepath.Join(primary, "loose.mp3")) {
		t.Error("track watched by the primary root was purged for its copy in .archive")
	}

	// Now its last copy's folder goes too, so the track goes with it.
	remove(ids[1])
	if !deleted(filepath.Join(ext, "dupe.mp3")) {
		t.Error("track whose only remaining copy was in the removed folder was kept")
	}
}
