package integration

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/httpapi/handlers"
	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/users"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Deleting an account removes the files the user uploaded, except one a
// global track has adopted.
func TestAdminDeleteUserRemovesUploads(t *testing.T) {
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
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}

	admin, target := uuid.New(), uuid.New()
	for _, u := range []struct {
		id   uuid.UUID
		role string
	}{{admin, "admin"}, {target, "user"}} {
		exec(`INSERT INTO users(id,username,password_hash,role,must_reset_password) VALUES($1,$2,'test',$3,FALSE)`,
			u.id, "deluser-"+u.id.String(), u.role)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM tracks WHERE file_path LIKE $1`, "%"+target.String()+"%")
		_, _ = pool.Exec(bg, `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{admin, target})
	})

	root := t.TempDir()
	userDir := filepath.Join(root, ".users", target.String())
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}
	own, adopted := filepath.Join(userDir, "own.mp3"), filepath.Join(userDir, "adopted.mp3")
	for _, p := range []string{own, adopted} {
		if err := os.WriteFile(p, []byte("audio"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	insert := func(owner *uuid.UUID, path string) {
		id := uuid.New()
		exec(`INSERT INTO tracks(id,owner_id,title,duration_ms,file_path,file_size,format,audio_sha256) VALUES($1,$2,'t',1000,$3,5,'mp3',$4)`,
			id, owner, path, id[:])
	}
	insert(&target, own)
	insert(&target, adopted)
	insert(nil, adopted) // a global track points at the same file

	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	token, _, err := sessions.Create(ctx, admin, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	h := &handlers.AdminUsers{
		DB:        pool,
		Users:     users.NewStore(pool),
		Playlists: playlists.NewStore(pool),
		Library:   library.NewStore(pool),
		MusicRoot: root,
	}
	router := chi.NewRouter()
	router.Use(middleware.Authenticate(sessions), middleware.RequireUser)
	router.Delete("/admin/users/{id}", h.Delete)
	req := httptest.NewRequest(http.MethodDelete, "/admin/users/"+target.String(), nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: token})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d: %s", w.Code, w.Body.String())
	}

	if _, err := os.Stat(own); !os.IsNotExist(err) {
		t.Errorf("own upload still on disk (stat err %v)", err)
	}
	if _, err := os.Stat(adopted); err != nil {
		t.Errorf("adopted upload was removed: %v", err)
	}
}
