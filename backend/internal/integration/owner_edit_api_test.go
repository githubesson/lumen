package integration

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
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

// cancelOnPut cancels the request the moment ingest stores a file's cover:
// a cancel that lands in the middle of a shared upload's ingest.
type cancelOnPut struct {
	storage.Storage
	cancel context.CancelFunc
}

func (c cancelOnPut) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) (storage.ObjectInfo, error) {
	info, err := c.Storage.Put(ctx, key, r, size, contentType)
	c.cancel()
	return info, err
}

// A shared upload cancelled while the server is ingesting a file finishes
// that ingest, then undoes it: no track, and no file left in uploads/ for the
// watcher to add after the client was told nothing was kept.
func TestCancelledSharedUploadFinishesThenUndoesTheFileInProgress(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	admin := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role, must_reset_password) VALUES($1,$2,'test','admin',FALSE)`,
		admin, "cancel-admin-"+admin.String()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, admin) })
	root := t.TempDir()
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM tracks WHERE starts_with(file_path, $1)`, root) })

	reqCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	store := storage.NewLocal(root)
	lib := library.NewStore(pool)
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: users.NewStore(pool), Sessions: sessions,
		Library: lib, Playlists: playlists.NewStore(pool), Storage: store,
		Ingest: &ingest.Service{
			DB: pool, Library: lib, Storage: cancelOnPut{Storage: store, cancel: cancel}, MusicRoot: root,
			Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		},
		CoverSignKey: []byte("test-key"),
	})

	// A FLAC with an album and embedded art, so ingest stores a cover.
	var art bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for x := 0; x < 8; x++ {
		for y := 0; y < 8; y++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 30), G: 90, B: uint8(y * 30), A: 255})
		}
	}
	if err := png.Encode(&art, img); err != nil {
		t.Fatal(err)
	}
	be := binary.BigEndian.AppendUint32
	pic := be(nil, 3) // front cover
	pic = be(pic, uint32(len("image/png")))
	pic = append(pic, "image/png"...)
	pic = be(pic, 0) // no description
	pic = be(be(be(be(pic, 8), 8), 32), 0)
	pic = be(pic, uint32(art.Len()))
	pic = append(pic, art.Bytes()...)
	song := filepath.Join(t.TempDir(), "song.flac")
	album := "Cancelled " + uuid.NewString()
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM albums WHERE title = $1`, album) })
	writeFLAC(t, song, "cancelled-audio-"+uuid.NewString(), "TITLE=Cancelled", "ALBUM="+album)
	data, err := os.ReadFile(song)
	if err != nil {
		t.Fatal(err)
	}
	// Re-mark the comment block as not last and append the picture as last.
	comments := 4 + 34 // "fLaC" + STREAMINFO header and body
	comments += 4
	data[comments] &^= 0x80
	bodyLen := int(data[comments+1])<<16 | int(data[comments+2])<<8 | int(data[comments+3])
	end := comments + 4 + bodyLen
	block := append([]byte{6 | 0x80, byte(len(pic) >> 16), byte(len(pic) >> 8), byte(len(pic))}, pic...)
	data = append(append(append([]byte{}, data[:end]...), block...), data[end:]...)

	token, _, err := sessions.Create(ctx, admin, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	mw.WriteField("scope", "global")
	part, err := mw.CreateFormFile("files", "song.flac")
	if err != nil {
		t.Fatal(err)
	}
	part.Write(data)
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/library/upload", &body).WithContext(reqCtx)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.AddCookie(&http.Cookie{Name: "session", Value: token})
	router.ServeHTTP(httptest.NewRecorder(), req)

	if reqCtx.Err() == nil {
		t.Fatal("the cover was never stored, so the cancel never happened mid-ingest")
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM tracks WHERE starts_with(file_path, $1)`, root).Scan(&n); err != nil || n != 0 {
		t.Fatalf("tracks left after the cancel = %d (%v), want 0", n, err)
	}
	left, _ := filepath.Glob(filepath.Join(root, "uploads", "*"))
	if len(left) != 0 {
		t.Fatalf("files left in uploads/ for the watcher: %v", left)
	}
}
