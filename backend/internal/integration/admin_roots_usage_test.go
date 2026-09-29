package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/httpapi/handlers"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAdminRootsUsage(t *testing.T) {
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

	primary := t.TempDir()
	nested := filepath.Join(primary, "artist")
	for path, size := range map[string]int{
		filepath.Join(primary, "a.flac"):         10,
		filepath.Join(nested, "album", "b.flac"): 200,
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, make([]byte, size), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	roots := musicroots.NewStore(pool)
	row, err := roots.Add(ctx, nested, "artist")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = roots.Delete(context.Background(), row.ID) })
	// Paused roots still take up space, so they're measured too.
	if _, err := roots.SetEnabled(ctx, row.ID, false); err != nil {
		t.Fatal(err)
	}

	admin := &handlers.AdminRoots{Store: roots, PrimaryRoot: primary}
	get := func(query string) map[string]musicroots.Usage {
		t.Helper()
		w := httptest.NewRecorder()
		admin.Usage(w, httptest.NewRequest(http.MethodGet, "/admin/library/roots/usage"+query, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", w.Code, w.Body.String())
		}
		var body struct {
			Roots      []musicroots.Usage `json:"roots"`
			MeasuredAt string             `json:"measured_at"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.MeasuredAt == "" {
			t.Fatal("measured_at is empty")
		}
		out := map[string]musicroots.Usage{}
		for _, u := range body.Roots {
			out[u.Path] = u
		}
		return out
	}

	got := get("")
	if u := got[primary]; u.Files != 2 || u.Bytes != 210 {
		t.Errorf("primary = %+v, want 2 files / 210 bytes", u)
	}
	if u := got[nested]; u.Files != 1 || u.Bytes != 200 {
		t.Errorf("nested = %+v, want 1 file / 200 bytes", u)
	}

	if err := os.WriteFile(filepath.Join(nested, "c.flac"), make([]byte, 5), 0o600); err != nil {
		t.Fatal(err)
	}
	if u := get("")[nested]; u.Files != 1 {
		t.Errorf("cached nested = %+v, want the cached 1 file", u)
	}
	if u := get("?refresh=1")[nested]; u.Files != 2 || u.Bytes != 205 {
		t.Errorf("refreshed nested = %+v, want 2 files / 205 bytes", u)
	}
}
