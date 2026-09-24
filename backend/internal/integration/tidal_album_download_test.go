package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/httpapi"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/tidaldl"
	"github.com/githubesson/lumen/internal/users"
)

// An admin can queue a whole release for download; only tracks with no
// library copy that TIDAL still lists are queued. The stored release (kept
// after TIDAL drops tracks) serves the album page without TIDAL.
func TestAlbumDownloadAPI(t *testing.T) {
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
	rel := "dl" + run
	tid := func(n string) string { return "t" + n + run }
	admin, member, saved := uuid.New(), uuid.New(), uuid.New()
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM tidal_download_requests WHERE tidal_album_id = $1`, rel)
		pool.Exec(c, `DELETE FROM tidal_downloads WHERE tidal_id = $1`, tid("1"))
		pool.Exec(c, `DELETE FROM tracks WHERE id = $1 OR external_id = ANY($2)`, saved,
			[]string{tid("1"), tid("2"), tid("3"), tid("4")})
		pool.Exec(c, `DELETE FROM tidal_albums WHERE tidal_id = $1`, rel)
		pool.Exec(c, `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{admin, member})
	})
	for id, role := range map[uuid.UUID]string{admin: "admin", member: "user"} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role) VALUES($1,$2,'test',$3)`,
			id, "albumdl-"+id.String(), role); err != nil {
			t.Fatal(err)
		}
	}
	lib := library.NewStore(pool)
	release := func(ids ...string) tidal.Album {
		a := tidal.Album{ID: rel, Title: "Record " + run, Artist: "Band", ReleaseYear: 2020, TrackCount: len(ids)}
		for i, id := range ids {
			a.Tracks = append(a.Tracks, tidal.Track{ID: id, Title: "Song " + id, TrackNo: i + 1, Artists: []string{"Band"}})
		}
		return a
	}
	// Stored with four tracks; TIDAL later drops track 2.
	if err := lib.SaveTIDALAlbum(ctx, release(tid("1"), tid("2"), tid("3"), tid("4"))); err != nil {
		t.Fatal(err)
	}
	later := release(tid("1"), tid("3"), tid("4"))
	later.Tracks[1].TrackNo, later.Tracks[2].TrackNo = 3, 4
	if err := lib.SaveTIDALAlbum(ctx, later); err != nil {
		t.Fatal(err)
	}
	// Track 1 is already in the library.
	if _, err := pool.Exec(ctx, `INSERT INTO tracks(id, title, duration_ms, file_path, file_size, format, audio_sha256)
		VALUES($1, 'Saved', 1000, $2, 5, 'flac', $3)`, saved, "/nowhere/"+run, saved[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tidal_downloads(tidal_id, status, local_track_id) VALUES($1, 'downloaded', $2)`,
		tid("1"), saved); err != nil {
		t.Fatal(err)
	}

	downloads := tidaldl.NewStore(pool)
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: users.NewStore(pool), Sessions: sessions, Library: lib,
		TIDALDownloads: downloads, TIDALDownload: &tidaldl.Worker{Store: downloads},
		CoverSignKey: []byte("test-key"),
	})
	do := func(user uuid.UUID, method, path string, out any) int {
		t.Helper()
		token, _, err := sessions.Create(ctx, user, httptest.NewRequest(http.MethodGet, "/", nil))
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if out != nil && rec.Code == http.StatusOK {
			if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
				t.Fatal(err)
			}
		}
		return rec.Code
	}

	path := "/api/admin/tidal/albums/" + rel + "/download"
	if code := do(member, http.MethodPost, path, nil); code != http.StatusForbidden {
		t.Fatalf("member download: %d", code)
	}
	var queued struct{ Queued, Saved, Unavailable int }
	if code := do(admin, http.MethodPost, path, &queued); code != http.StatusOK {
		t.Fatalf("admin download: %d", code)
	}
	if queued.Queued != 2 || queued.Saved != 1 || queued.Unavailable != 1 {
		t.Fatalf("download = %+v", queued)
	}
	var requested []string
	rows, err := pool.Query(ctx, `
		SELECT r.tidal_id FROM tidal_download_requests r
		JOIN tracks t ON t.external_id = r.tidal_id AND t.source = 'tidal'
		WHERE r.tidal_album_id = $1`, rel)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		requested = append(requested, id)
	}
	rows.Close()
	sort.Strings(requested)
	if len(requested) != 2 || requested[0] != tid("3") || requested[1] != tid("4") {
		t.Fatalf("requested (with remote rows) = %v", requested)
	}

	// No TIDAL configured: the page comes from the stored release.
	var page struct {
		TrackCount  int `json:"track_count"`
		SavedCount  int `json:"saved_count"`
		QueuedCount int `json:"queued_count"`
		Tracks      []struct {
			ID          string `json:"id"`
			Unavailable bool   `json:"unavailable"`
		} `json:"tracks"`
	}
	if code := do(admin, http.MethodGet, "/api/tidal/albums/"+rel, &page); code != http.StatusOK {
		t.Fatalf("stored album page: %d", code)
	}
	if page.TrackCount != 4 || page.SavedCount != 1 || page.QueuedCount != 2 || len(page.Tracks) != 4 ||
		page.Tracks[0].ID != saved.String() || page.Tracks[1].ID != "tidal:"+tid("2") || !page.Tracks[1].Unavailable ||
		page.Tracks[2].Unavailable {
		t.Fatalf("album page = %+v", page)
	}

	var cancelled struct{ Cancelled int }
	if code := do(admin, http.MethodDelete, path, &cancelled); code != http.StatusOK || cancelled.Cancelled != 2 {
		t.Fatalf("cancel: %d %+v", code, cancelled)
	}
}
