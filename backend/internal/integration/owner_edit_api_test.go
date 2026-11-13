package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpapi"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/storage"
	"github.com/githubesson/lumen/internal/users"
)

// The edit routes non-admins now reach: only their own personal uploads, and
// never by moving a track into an album by id.
func TestOwnerEditRoutes(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	owner := redteamUser(t, ctx, pool)
	other := redteamUser(t, ctx, pool)
	track := redteamTrack(t, ctx, pool, &owner, nil)
	global := redteamTrack(t, ctx, pool, nil, nil)

	root := t.TempDir()
	store := storage.NewLocal(root)
	lib := library.NewStore(pool)
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: users.NewStore(pool), Sessions: sessions,
		Library: lib, Playlists: playlists.NewStore(pool), Storage: store,
		Ingest:       &ingest.Service{DB: pool, Storage: store, MusicRoot: root},
		CoverSignKey: []byte("test-key"),
	})
	do := func(user uuid.UUID, method, path string, body io.Reader, contentType string) *httptest.ResponseRecorder {
		t.Helper()
		token, _, err := sessions.Create(ctx, user, httptest.NewRequest(http.MethodGet, "/", nil))
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, body)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	patch := func(user, id uuid.UUID, body string) int {
		t.Helper()
		return do(user, http.MethodPatch, "/api/tracks/"+id.String(), bytes.NewBufferString(body), "application/json").Code
	}

	if code := patch(owner, global, `{"title":"mine now"}`); code != http.StatusNotFound {
		t.Fatalf("non-admin PATCH of a shared track = %d, want 404", code)
	}
	if code := patch(other, track, `{"title":"mine now"}`); code != http.StatusNotFound {
		t.Fatalf("PATCH of another user's upload = %d, want 404", code)
	}
	album := redteamAlbum(t, ctx, pool, "", nil)
	if code := patch(owner, track, `{"album_id":"`+album.String()+`"}`); code != http.StatusForbidden {
		t.Fatalf("non-admin PATCH with album_id = %d, want 403", code)
	}
	if code := patch(owner, track, `{"title":"Fixed title"}`); code != http.StatusOK {
		t.Fatalf("owner PATCH of their upload = %d, want 200", code)
	}
	var title string
	if err := pool.QueryRow(ctx, `SELECT title FROM tracks WHERE id=$1`, global).Scan(&title); err != nil || title == "mine now" {
		t.Fatalf("shared track title = %q (%v)", title, err)
	}

	var cover bytes.Buffer
	mw := multipart.NewWriter(&cover)
	part, err := mw.CreateFormFile("file", "cover.png")
	if err != nil {
		t.Fatal(err)
	}
	part.Write([]byte("not reached"))
	mw.Close()
	if rec := do(other, http.MethodPut, "/api/tracks/"+track.String()+"/cover", &cover, mw.FormDataContentType()); rec.Code != http.StatusNotFound {
		t.Fatalf("PUT cover on another user's upload = %d (%s), want 404", rec.Code, rec.Body)
	}
}

// An admin's shared upload of audio a user already uploaded takes over that
// user's row: the result says so, since that track isn't the upload's to undo.
func TestSharedUploadReportsPromotion(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	user := redteamUser(t, ctx, pool)
	admin := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role, must_reset_password) VALUES($1,$2,'test','admin',FALSE)`,
		admin, "promo-admin-"+admin.String()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, admin) })

	root := t.TempDir()
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM tracks WHERE starts_with(file_path, $1)`, root)
	})
	store := storage.NewLocal(root)
	lib := library.NewStore(pool)
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: users.NewStore(pool), Sessions: sessions,
		Library: lib, Playlists: playlists.NewStore(pool), Storage: store,
		Ingest: &ingest.Service{
			DB: pool, Library: lib, Storage: store, MusicRoot: root,
			Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		},
		CoverSignKey: []byte("test-key"),
	})

	song := filepath.Join(t.TempDir(), "song.flac")
	writeFLAC(t, song, "promotion-audio-"+uuid.NewString())
	data, err := os.ReadFile(song)
	if err != nil {
		t.Fatal(err)
	}
	type uploadResult struct {
		Inserted bool   `json:"inserted"`
		Promoted bool   `json:"promoted"`
		TrackID  string `json:"track_id"`
		Error    string `json:"error"`
		// Whether the field was there at all: clients tell an older server,
		// which never sends it, by its absence.
		saidPromoted bool
	}
	upload := func(as uuid.UUID, scope string) uploadResult {
		t.Helper()
		token, _, err := sessions.Create(ctx, as, httptest.NewRequest(http.MethodGet, "/", nil))
		if err != nil {
			t.Fatal(err)
		}
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		mw.WriteField("scope", scope)
		part, err := mw.CreateFormFile("files", "song.flac")
		if err != nil {
			t.Fatal(err)
		}
		part.Write(data)
		mw.Close()
		req := httptest.NewRequest(http.MethodPost, "/api/library/upload", &body)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		var results []uploadResult
		var raw []map[string]json.RawMessage
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &results) != nil || len(results) != 1 ||
			json.Unmarshal(rec.Body.Bytes(), &raw) != nil {
			t.Fatalf("upload as %s = %d %s", scope, rec.Code, rec.Body)
		}
		_, results[0].saidPromoted = raw[0]["promoted"]
		return results[0]
	}

	personal := upload(user, "personal")
	if !personal.Inserted || personal.Promoted || personal.Error != "" {
		t.Fatalf("personal upload = %+v", personal)
	}
	shared := upload(admin, "global")
	if !shared.Inserted || !shared.Promoted || shared.TrackID != personal.TrackID {
		t.Fatalf("shared upload of the same audio = %+v, want inserted and promoted onto %s", shared, personal.TrackID)
	}
	fresh := filepath.Join(t.TempDir(), "fresh.flac")
	writeFLAC(t, fresh, "fresh-audio-"+uuid.NewString())
	if data, err = os.ReadFile(fresh); err != nil {
		t.Fatal(err)
	}
	if got := upload(admin, "global"); !got.Inserted || got.Promoted || !got.saidPromoted {
		t.Fatalf("shared upload of new audio = %+v, want inserted, and \"promoted\": false said outright", got)
	}
}
