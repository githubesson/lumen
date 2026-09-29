package integration

import (
	"context"
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
	for _, d := range []string{keepDir, nested} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	tracks := map[string]uuid.UUID{}
	for _, p := range []string{
		filepath.Join(ext, "gone.mp3"),
		filepath.Join(keepDir, "kept.mp3"),
		filepath.Join(nested, "covered.mp3"),
	} {
		id := uuid.New()
		tracks[p] = id
		if _, err := pool.Exec(ctx, `INSERT INTO tracks(id,title,duration_ms,file_path,file_size,format,audio_sha256) VALUES($1,'t',1000,$2,1,'mp3',$3)`, id, p, id[:]); err != nil {
			t.Fatal(err)
		}
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
	for _, p := range []string{ext, keepDir, nested} {
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
	if deleted(filepath.Join(keepDir, "kept.mp3")) {
		t.Error("track under a still-watched folder inside the removed one was purged")
	}
	if deleted(filepath.Join(nested, "covered.mp3")) {
		t.Error("track under a folder the primary root still covers was purged")
	}
}
