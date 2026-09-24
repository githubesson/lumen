package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/httpapi"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/tidaldl"
	"github.com/githubesson/lumen/internal/users"
)

func TestTIDALAutoDownloadAPI(t *testing.T) {
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
	// A cleanup, not a defer: the data cleanup below must run before this.
	t.Cleanup(pool.Close)

	member, admin := uuid.New(), uuid.New()
	for id, role := range map[uuid.UUID]string{member: "user", admin: "admin"} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role) VALUES($1,$2,'test',$3)`,
			id, "autodl-"+id.String(), role); err != nil {
			t.Fatal(err)
		}
	}
	lib := library.NewStore(pool)
	pls := playlists.NewStore(pool)
	downloads := tidaldl.NewStore(pool)
	roots := musicroots.NewStore(pool)
	primary := t.TempDir()
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: users.NewStore(pool), Sessions: sessions, Library: lib, Playlists: pls,
		MusicRoots: roots, MusicRoot: primary, TIDALDownloads: downloads,
		TIDALDownload: &tidaldl.Worker{Store: downloads, Roots: roots, PrimaryRoot: primary},
		CoverSignKey:  []byte("test-key"),
	})

	playlist, err := pls.Create(ctx, member, "mine", "", playlists.VisibilityPrivate)
	if err != nil {
		t.Fatal(err)
	}
	tidalID := "api" + uuid.NewString()[:8]
	local := uuid.New()
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM playlists WHERE id = $1`, playlist.ID)
		pool.Exec(c, `DELETE FROM tidal_downloads WHERE tidal_id = $1`, tidalID)
		pool.Exec(c, `DELETE FROM tracks WHERE id = $1`, local)
		pool.Exec(c, `DELETE FROM settings WHERE key = 'tidal_auto_download'`)
		pool.Exec(c, `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{member, admin})
	})

	do := func(user uuid.UUID, method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		token, _, err := sessions.Create(ctx, user, httptest.NewRequest(http.MethodGet, "/", nil))
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	toggle := "/api/playlists/" + playlist.ID.String() + "/tidal-auto-download"
	if rec := do(member, http.MethodPut, toggle, `{"enabled":true}`); rec.Code != http.StatusForbidden {
		t.Fatalf("owner without admin: %d %s", rec.Code, rec.Body)
	}
	if rec := do(admin, http.MethodPut, toggle, `{}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing enabled: %d", rec.Code)
	}
	if rec := do(admin, http.MethodPut, toggle, `{"enabled":true}`); rec.Code != http.StatusNoContent {
		t.Fatalf("admin toggle: %d %s", rec.Code, rec.Body)
	}
	rec := do(member, http.MethodGet, "/api/playlists/"+playlist.ID.String(), "")
	var got struct {
		TIDALAutoDownload bool `json:"tidal_auto_download"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || !got.TIDALAutoDownload {
		t.Fatalf("playlist response %s, %v", rec.Body, err)
	}

	if rec := do(member, http.MethodGet, "/api/admin/tidal/auto-download", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("member read settings: %d", rec.Code)
	}
	if rec := do(admin, http.MethodPut, "/api/admin/tidal/auto-download", `{"subdir":"../out"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("escaping subdir: %d %s", rec.Code, rec.Body)
	}
	if rec := do(admin, http.MethodPut, "/api/admin/tidal/auto-download", `{"root_id":"`+uuid.NewString()+`"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown root: %d %s", rec.Code, rec.Body)
	}
	rec = do(admin, http.MethodPut, "/api/admin/tidal/auto-download", `{"subdir":" Lossless/TIDAL "}`)
	var status struct {
		Subdir      string `json:"subdir"`
		Destination string `json:"destination"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("save settings: %d %s", rec.Code, rec.Body)
	}
	if status.Subdir != "Lossless/TIDAL" || status.Destination != primary+"/Lossless/TIDAL" {
		t.Fatalf("settings = %+v", status)
	}

	// A TIDAL track that was already saved is added as its local copy, even
	// with no TIDAL proxy configured.
	if _, err := pool.Exec(ctx, `INSERT INTO tracks(id, title, duration_ms, file_path, file_size, format, audio_sha256)
		VALUES($1, 'Saved', 1000, $2, 5, 'flac', $3)`, local, "/nowhere/"+tidalID+".flac", local[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tidal_downloads(tidal_id, status, local_track_id) VALUES($1, 'downloaded', $2)`,
		tidalID, local); err != nil {
		t.Fatal(err)
	}
	if rec := do(member, http.MethodPost, "/api/playlists/"+playlist.ID.String()+"/tracks",
		`{"track_ids":["tidal:`+tidalID+`"]}`); rec.Code != http.StatusNoContent {
		t.Fatalf("add saved tidal track: %d %s", rec.Code, rec.Body)
	}
	entries, err := pls.Tracks(ctx, playlist.ID)
	if err != nil || len(entries) != 1 || entries[0].TrackID != local {
		t.Fatalf("entries = %+v, %v", entries, err)
	}
}
