package integration

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/httpapi/handlers"
	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPlaybackReads(t *testing.T) {
	url := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	if err := db.Migrate(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	counter := &readQueryCounter{}
	cfg.ConnConfig.Tracer = counter
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	viewer, other, trackID := uuid.New(), uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{viewer, other} {
		exec(`INSERT INTO users(id,username,password_hash,role,must_reset_password) VALUES($1,$2,'test','admin',FALSE)`, id, "playback-"+id.String())
		defer pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, id)
	}
	primary, extra := t.TempDir(), t.TempDir()
	filePath := filepath.Join(extra, "song.mp3")
	audio := "0123456789abcdef"
	if err := os.WriteFile(filePath, []byte(audio), 0600); err != nil {
		t.Fatal(err)
	}
	// Deliberately stale DB size: the stream must still stat the actual file.
	exec(`INSERT INTO tracks(id,title,duration_ms,file_path,file_size,format,audio_sha256) VALUES($1,'test',1000,$2,999,'mp3',$3)`, trackID, filePath, trackID[:])
	defer pool.Exec(ctx, `DELETE FROM tracks WHERE id=$1`, trackID)
	lib := library.NewStore(pool)
	roots := musicroots.NewStore(pool)
	// Concurrent cold callers share one load, including an empty root set.
	counter.queries.Store(0)
	var readers sync.WaitGroup
	for range 12 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			paths, err := roots.EnabledPaths(ctx)
			if err != nil || len(paths) != 0 {
				t.Errorf("initial roots = %v, err = %v", paths, err)
			}
		}()
	}
	readers.Wait()
	if n := counter.queries.Load(); n != 1 {
		t.Fatalf("concurrent root loads used %d queries", n)
	}
	svc := &ingest.Service{MusicRoot: primary, Roots: func(ctx context.Context) []string {
		paths, err := roots.EnabledPaths(ctx)
		if err != nil {
			return []string{primary}
		}
		return append([]string{primary}, paths...)
	}}
	svc.AllRoots(ctx)
	svc.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	stream := &handlers.Tracks{Library: lib, Ingest: svc}
	admin := &handlers.AdminRoots{Store: roots, Library: lib, Ingest: svc, PrimaryRoot: primary, Refresh: func() {
		// Same refresh behavior as main, with no filesystem watcher.
		svc.AllRoots(ctx)
	}}
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	token, _, err := sessions.Create(ctx, viewer, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(middleware.Authenticate(sessions), middleware.RequireUser)
	router.Get("/tracks/{id}/stream", stream.Stream)
	router.Post("/roots", admin.Add)
	router.Patch("/roots/{id}", admin.Patch)
	router.Delete("/roots/{id}", admin.Delete)
	request := func(method, path, body, byteRange string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: "session", Value: token})
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		if byteRange != "" {
			r.Header.Set("Range", byteRange)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	streamURL := "/tracks/" + trackID.String() + "/stream"
	checkStream := func(status int, byteRange, wantBody string) {
		t.Helper()
		counter.queries.Store(0)
		w := request(http.MethodGet, streamURL, "", byteRange)
		if w.Code != status {
			t.Fatalf("stream status=%d, want %d: %s", w.Code, status, w.Body.String())
		}
		if n := counter.queries.Load(); n != 2 {
			t.Fatalf("stream used %d queries; want one auth + one playback query", n)
		}
		if status == http.StatusOK || status == http.StatusPartialContent {
			if w.Body.String() != wantBody || w.Header().Get("Content-Type") != "audio/mpeg" {
				t.Fatalf("stream response = %q, headers %v", w.Body.String(), w.Header())
			}
			if status == http.StatusPartialContent && w.Header().Get("Content-Range") != "bytes 4-7/16" {
				t.Fatalf("wrong range: %v", w.Header())
			}
		}
	}

	checkStream(http.StatusForbidden, "", "")
	body, _ := json.Marshal(map[string]string{"path": extra})
	w := request(http.MethodPost, "/roots", string(body), "")
	if w.Code != http.StatusCreated {
		t.Fatal(w.Body.String())
	}
	var added musicroots.Root
	if err := json.Unmarshal(w.Body.Bytes(), &added); err != nil {
		t.Fatal(err)
	}
	defer roots.Delete(ctx, added.ID)
	rootURL := "/roots/" + added.ID.String()
	checkStream(http.StatusOK, "", audio)
	checkStream(http.StatusPartialContent, "bytes=4-7", "4567")

	// Mutating a returned snapshot must not change future authorization checks.
	paths, err := roots.EnabledPaths(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(paths, []string{extra}) {
		t.Fatalf("unexpected roots: %v", paths)
	}
	paths[0] = primary
	checkStream(http.StatusOK, "", audio)
	for _, enabled := range []bool{false, true} {
		body, _ := json.Marshal(map[string]bool{"enabled": enabled})
		w = request(http.MethodPatch, rootURL, string(body), "")
		if w.Code != http.StatusOK {
			t.Fatal(w.Body.String())
		}
		if enabled {
			checkStream(http.StatusOK, "", audio)
		} else {
			checkStream(http.StatusForbidden, "", "")
		}
	}

	// Ownership and soft deletion are checked afresh on every request.
	exec(`UPDATE tracks SET owner_id=$2 WHERE id=$1`, trackID, other)
	checkStream(http.StatusNotFound, "", "")
	exec(`UPDATE tracks SET owner_id=$2 WHERE id=$1`, trackID, viewer)
	checkStream(http.StatusOK, "", audio)
	exec(`UPDATE tracks SET deleted_at=NOW() WHERE id=$1`, trackID)
	checkStream(http.StatusNotFound, "", "")
	exec(`UPDATE tracks SET deleted_at=NULL WHERE id=$1`, trackID)

	// A materialized remote UUID still routes to TIDAL, even when hidden from
	// library browsing. The unconfigured client returns 503 rather than using FS.
	exec(`UPDATE tracks SET source='tidal', external_id='123', library_visible=FALSE WHERE id=$1`, trackID)
	checkStream(http.StatusServiceUnavailable, "", "")
	exec(`UPDATE tracks SET source='local', external_id='', library_visible=TRUE WHERE id=$1`, trackID)

	if err := os.Remove(filePath); err != nil {
		t.Fatal(err)
	}
	checkStream(http.StatusGone, "", "")
	if err := os.WriteFile(filePath, []byte(audio), 0600); err != nil {
		t.Fatal(err)
	}
	checkStream(http.StatusOK, "", audio)
	w = request(http.MethodDelete, rootURL+"?purge=false", "", "")
	if w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	checkStream(http.StatusForbidden, "", "")
}
