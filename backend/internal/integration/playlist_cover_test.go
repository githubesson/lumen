package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
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

func TestPlaylistCoverAPI(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	owner := redteamUser(t, ctx, pool)
	editor := redteamUser(t, ctx, pool)
	stranger := redteamUser(t, ctx, pool)

	root := t.TempDir()
	store := storage.NewLocal(root)
	pls := playlists.NewStore(pool)
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: users.NewStore(pool), Sessions: sessions,
		Library: library.NewStore(pool), Playlists: pls, Storage: store,
		Ingest:       &ingest.Service{DB: pool, Storage: store, MusicRoot: root},
		CoverSignKey: []byte("test-key"),
	})

	p, err := pls.Create(ctx, owner, "covered", "", playlists.VisibilityCollaborative)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM playlists WHERE id = $1`, p.ID) })
	if _, err := pool.Exec(ctx, `INSERT INTO playlist_collaborators(playlist_id, user_id, role, status) VALUES($1, $2, 'editor', 'accepted')`, p.ID, editor); err != nil {
		t.Fatal(err)
	}

	do := func(user uuid.UUID, method, path string, body *bytes.Buffer, contentType string) *httptest.ResponseRecorder {
		t.Helper()
		token, _, err := sessions.Create(ctx, user, httptest.NewRequest(http.MethodGet, "/", nil))
		if err != nil {
			t.Fatal(err)
		}
		if body == nil {
			body = &bytes.Buffer{}
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
	upload := func(user uuid.UUID, data []byte) *httptest.ResponseRecorder {
		t.Helper()
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		part, err := mw.CreateFormFile("file", "cover.png")
		if err != nil {
			t.Fatal(err)
		}
		part.Write(data)
		mw.Close()
		return do(user, http.MethodPut, "/api/playlists/"+p.ID.String()+"/cover", &body, mw.FormDataContentType())
	}
	customCover := func(rec *httptest.ResponseRecorder) string {
		t.Helper()
		var got struct {
			CustomCover string `json:"custom_cover"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode %s: %v", rec.Body, err)
		}
		return got.CustomCover
	}

	img := image.NewRGBA(image.Rect(0, 0, 40, 40))
	for x := 0; x < 40; x++ {
		for y := 0; y < 40; y++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 6), G: 80, B: uint8(y * 6), A: 255})
		}
	}
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, img); err != nil {
		t.Fatal(err)
	}
	coverPath := "/api/playlists/" + p.ID.String() + "/cover"

	if rec := do(owner, http.MethodGet, coverPath, nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("cover before upload: %d", rec.Code)
	}
	if rec := upload(editor, pngData.Bytes()); rec.Code != http.StatusForbidden {
		t.Fatalf("editor upload: %d %s", rec.Code, rec.Body)
	}
	if rec := upload(stranger, pngData.Bytes()); rec.Code != http.StatusNotFound {
		t.Fatalf("stranger upload: %d %s", rec.Code, rec.Body)
	}
	if rec := upload(owner, []byte("not an image")); rec.Code != http.StatusBadRequest {
		t.Fatalf("non-image upload: %d %s", rec.Code, rec.Body)
	}

	rec := upload(owner, pngData.Bytes())
	if rec.Code != http.StatusOK {
		t.Fatalf("owner upload: %d %s", rec.Code, rec.Body)
	}
	version := customCover(rec)
	if version == "" {
		t.Fatalf("upload response has no custom_cover: %s", rec.Body)
	}

	// Collaborators see it, on the list and at the cover URL; strangers don't.
	rec = do(editor, http.MethodGet, "/api/playlists", nil, "")
	var listed []struct {
		ID          string `json:"id"`
		CustomCover string `json:"custom_cover"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range listed {
		if row.ID == p.ID.String() {
			found = true
			if row.CustomCover != version {
				t.Fatalf("listed custom_cover %q, want %q", row.CustomCover, version)
			}
		}
	}
	if !found {
		t.Fatal("playlist missing from the editor's list")
	}
	for _, path := range []string{coverPath, coverPath + "?size=64&v=" + version} {
		rec = do(editor, http.MethodGet, path, nil, "")
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/jpeg" {
			t.Fatalf("editor GET %s: %d %q", path, rec.Code, rec.Header().Get("Content-Type"))
		}
	}
	if rec := do(stranger, http.MethodGet, coverPath, nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("stranger GET: %d", rec.Code)
	}

	if rec := do(editor, http.MethodDelete, coverPath, nil, ""); rec.Code != http.StatusForbidden {
		t.Fatalf("editor delete: %d", rec.Code)
	}
	rec = do(owner, http.MethodDelete, coverPath, nil, "")
	if rec.Code != http.StatusOK || customCover(rec) != "" {
		t.Fatalf("owner delete: %d %s", rec.Code, rec.Body)
	}
	if rec := do(owner, http.MethodGet, coverPath, nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("cover after delete: %d", rec.Code)
	}
}
