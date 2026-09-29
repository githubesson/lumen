package integration

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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

// Deleting an account is all or nothing, and removes the files the user
// uploaded except one a global track has adopted.
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
	dupe := filepath.Join(userDir, "own-again.mp3") // a duplicate upload, kept as an alias
	// A duplicate of a global track that ingest failed to unlink: no row at all.
	stray := filepath.Join(userDir, "album", "stray.mp3")
	if err := os.MkdirAll(filepath.Dir(stray), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{own, adopted, dupe, stray} {
		if err := os.WriteFile(p, []byte("audio"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	insert := func(owner *uuid.UUID, path string) uuid.UUID {
		id := uuid.New()
		exec(`INSERT INTO tracks(id,owner_id,title,duration_ms,file_path,file_size,format,audio_sha256) VALUES($1,$2,'t',1000,$3,5,'mp3',$4)`,
			id, owner, path, id[:])
		return id
	}
	ownID := insert(&target, own)
	exec(`INSERT INTO track_aliases(track_id, file_path) VALUES($1, $2)`, ownID, dupe)
	insert(&target, adopted)
	insert(nil, adopted) // a global track points at the same file

	keepPL, dropPL := uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{keepPL, dropPL} {
		exec(`INSERT INTO playlists(id, owner_id, name) VALUES($1, $2, 'p')`, id, target)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM playlists WHERE id = ANY($1)`, []uuid.UUID{keepPL, dropPL})
	})

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
	del := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodDelete, "/admin/users/"+target.String(), strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	// The second handover fails, so nothing happens: the first playlist isn't
	// deleted and the account stays.
	bad := fmt.Sprintf(`{"playlist_dispositions":[{"playlist_id":%q,"action":"delete"},{"playlist_id":%q,"action":"transfer","new_owner_id":%q}]}`,
		dropPL, keepPL, uuid.New())
	if w := del(bad); w.Code != http.StatusBadRequest {
		t.Fatalf("bad handover status = %d: %s", w.Code, w.Body.String())
	}
	if n := count(`SELECT COUNT(*) FROM playlists WHERE id = ANY($1) AND owner_id = $2`, []uuid.UUID{keepPL, dropPL}, target); n != 2 {
		t.Fatalf("after a failed delete the user owns %d of 2 playlists; want nothing changed", n)
	}
	if _, err := os.Stat(own); err != nil {
		t.Fatalf("failed delete removed an upload: %v", err)
	}

	good := fmt.Sprintf(`{"playlist_dispositions":[{"playlist_id":%q,"action":"delete"},{"playlist_id":%q,"action":"transfer","new_owner_id":%q}]}`,
		dropPL, keepPL, admin)
	if w := del(good); w.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d: %s", w.Code, w.Body.String())
	}
	if n := count(`SELECT COUNT(*) FROM playlists WHERE id = $1 AND owner_id = $2`, keepPL, admin); n != 1 {
		t.Errorf("handed-over playlist not owned by the admin")
	}
	if n := count(`SELECT COUNT(*) FROM playlists WHERE id = $1`, dropPL); n != 0 {
		t.Errorf("playlist marked for deletion still exists")
	}

	for _, p := range []string{own, dupe, stray} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("upload %s still on disk (stat err %v)", filepath.Base(p), err)
		}
	}
	if _, err := os.Stat(adopted); err != nil {
		t.Errorf("adopted upload was removed: %v", err)
	}
}
