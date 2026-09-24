package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/httpapi"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/users"
)

// A library album that copies part of a TIDAL release lists the whole
// release, with library copies in place of the TIDAL tracks they copy.
func TestLibraryAlbumShowsFullTIDALRelease(t *testing.T) {
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
	t.Cleanup(pool.Close)

	run := uuid.NewString()[:8]
	rel := "view" + run
	viewer := uuid.New()
	album := uuid.New()
	saved, isrcCopy, extra := uuid.New(), uuid.New(), uuid.New()
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM tidal_downloads WHERE tidal_id = $1`, "t1"+run)
		pool.Exec(c, `DELETE FROM tracks WHERE id = ANY($1)`, []uuid.UUID{saved, isrcCopy, extra})
		pool.Exec(c, `DELETE FROM albums WHERE id = $1`, album)
		pool.Exec(c, `DELETE FROM tidal_albums WHERE tidal_id = $1`, rel)
		pool.Exec(c, `DELETE FROM users WHERE id = $1`, viewer)
	})
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id, username, password_hash, role) VALUES($1, $2, 'test', 'user')`, []any{viewer, "albumview-" + run}},
		{`INSERT INTO albums(id, title, tidal_album_id) VALUES($1, $2, $3)`, []any{album, "Record " + run, rel}},
		{`INSERT INTO tracks(id, album_id, title, track_no, duration_ms, file_path, file_size, format, audio_sha256, isrc)
		  VALUES ($1, $4, 'One', 1, 1000, $5, 5, 'flac', $8, NULL),
		         ($2, $4, 'Two', 2, 2000, $6, 5, 'flac', $9, 'ZZ0000000002'),
		         ($3, $4, 'Bonus', 9, 5000, $7, 5, 'flac', $10, NULL)`,
			[]any{saved, isrcCopy, extra, album, "/nowhere/1" + run, "/nowhere/2" + run, "/nowhere/9" + run,
				saved[:], isrcCopy[:], extra[:]}},
		{`INSERT INTO tidal_downloads(tidal_id, status, local_track_id) VALUES($1, 'downloaded', $2)`, []any{"t1" + run, saved}},
	} {
		if _, err := pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	lib := library.NewStore(pool)
	if err := lib.SaveTIDALAlbum(ctx, tidal.Album{
		ID: rel, Title: "Record " + run, Artist: "Band", Artists: []string{"Band", "Guest"}, ReleaseYear: 2021, TrackCount: 3,
		Tracks: []tidal.Track{
			{ID: "t1" + run, Title: "One", TrackNo: 1, DurationMS: 1000},
			{ID: "t2" + run, Title: "Two", TrackNo: 2, DurationMS: 2000, ISRC: "ZZ0000000002"},
			{ID: "t3" + run, Title: "Three", TrackNo: 3, DurationMS: 3000},
		},
	}); err != nil {
		t.Fatal(err)
	}

	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: users.NewStore(pool), Sessions: sessions, Library: lib, CoverSignKey: []byte("test-key"),
	})
	token, _, err := sessions.Create(ctx, viewer, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	get := func(path string, out any) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, rec.Code, rec.Body)
		}
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			t.Fatal(err)
		}
	}

	var head struct {
		TrackCount   int      `json:"track_count"`
		SavedCount   int      `json:"saved_count"`
		TIDALAlbumID string   `json:"tidal_album_id"`
		ArtistNames  []string `json:"artist_names"`
		ReleaseYear  int      `json:"release_year"`
	}
	get("/api/albums/"+album.String(), &head)
	if head.TrackCount != 4 || head.SavedCount != 3 || head.TIDALAlbumID != rel || len(head.ArtistNames) != 2 || head.ReleaseYear != 2021 {
		t.Fatalf("album = %+v", head)
	}
	var tracks []struct {
		ID     string `json:"id"`
		Source string `json:"source"`
	}
	get("/api/albums/"+album.String()+"/tracks", &tracks)
	want := []string{saved.String(), isrcCopy.String(), "tidal:t3" + run, extra.String()}
	if len(tracks) != len(want) {
		t.Fatalf("tracks = %+v, want %v", tracks, want)
	}
	for i, id := range want {
		if tracks[i].ID != id {
			t.Fatalf("tracks = %+v, want %v", tracks, want)
		}
	}
}

// When only the first page of a release can be fetched, the album page falls
// back to the complete stored release instead of showing the partial page.
func TestTIDALAlbumPageFallsBackToStoredRelease(t *testing.T) {
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
	t.Cleanup(pool.Close)

	run := uuid.NewString()[:8]
	rel := "770" + strconv.Itoa(int(time.Now().UnixNano()%100000))
	viewer := uuid.New()
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM tidal_albums WHERE tidal_id = $1`, rel)
		pool.Exec(c, `DELETE FROM users WHERE id = $1`, viewer)
	})
	if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role) VALUES($1, $2, 'test', 'user')`,
		viewer, "partial-"+run); err != nil {
		t.Fatal(err)
	}
	lib := library.NewStore(pool)
	stored := tidal.Album{ID: rel, Title: "Long " + run, TrackCount: 150}
	for i := 0; i < 150; i++ {
		stored.Tracks = append(stored.Tracks, tidal.Track{ID: strconv.Itoa(1000 + i), Title: "T", TrackNo: i + 1})
	}
	if err := lib.SaveTIDALAlbum(ctx, stored); err != nil {
		t.Fatal(err)
	}

	// The proxy serves the first 100 tracks, then fails.
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("offset") != "0" {
			http.Error(w, "upstream down", http.StatusBadGateway)
			return
		}
		items := make([]string, 100)
		for i := range items {
			items[i] = `{"type":"track","item":{"id":` + strconv.Itoa(1000+i) + `,"title":"T","trackNumber":` + strconv.Itoa(i+1) + `}}`
		}
		_, _ = w.Write([]byte(`{"data":{"id":` + rel + `,"title":"Long","numberOfTracks":150,"items":[` + strings.Join(items, ",") + `]}}`))
	}))
	defer proxy.Close()

	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: users.NewStore(pool), Sessions: sessions, Library: lib, CoverSignKey: []byte("test-key"),
		TIDAL: tidal.NewClient(tidal.Config{HifiAPIURL: proxy.URL}),
	})
	token, _, err := sessions.Create(ctx, viewer, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/tidal/albums/"+rel, nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: token})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	var page struct {
		Tracks []json.RawMessage `json:"tracks"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &page) != nil {
		t.Fatalf("album page: %d %s", rec.Code, rec.Body)
	}
	if len(page.Tracks) != 150 {
		t.Fatalf("album page lists %d tracks, want the stored 150", len(page.Tracks))
	}
}
