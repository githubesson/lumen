package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/httpapi"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/users"
)

// The playlist screen polls while tidal_queued is above zero, so a TIDAL
// entry whose download failed must not count while it waits out a backoff of
// up to a day; tidal_retry_at says when to look again, and once the retry is
// due the entry counts again.
func TestPlaylistTracksTIDALQueued(t *testing.T) {
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

	owner := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role) VALUES($1,$2,'test','user')`,
		owner, "queued-"+owner.String()); err != nil {
		t.Fatal(err)
	}
	lib := library.NewStore(pool)
	pls := playlists.NewStore(pool)
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: users.NewStore(pool), Sessions: sessions, Library: lib, Playlists: pls,
		CoverSignKey: []byte("test-key"),
	})

	playlist, err := pls.Create(ctx, owner, "queued", "", playlists.VisibilityPrivate)
	if err != nil {
		t.Fatal(err)
	}
	waiting, failed := "q"+uuid.NewString()[:8], "f"+uuid.NewString()[:8]
	var tracks []uuid.UUID
	for _, id := range []string{waiting, failed} {
		track, err := lib.UpsertRemoteTrack(ctx, library.RemoteTrackInput{
			Source: "tidal", ExternalID: id, Title: id, ArtistNames: []string{"Artist"}, DurationMS: 1000,
		})
		if err != nil {
			t.Fatal(err)
		}
		tracks = append(tracks, track)
	}
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM playlists WHERE id = $1`, playlist.ID)
		pool.Exec(c, `DELETE FROM tidal_downloads WHERE tidal_id = ANY($1)`, []string{waiting, failed})
		pool.Exec(c, `DELETE FROM tracks WHERE id = ANY($1)`, tracks)
		pool.Exec(c, `DELETE FROM users WHERE id = $1`, owner)
	})
	if err := pls.AddTracks(ctx, playlist.ID, tracks, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tidal_downloads(tidal_id, status, attempts, next_attempt_at)
		VALUES($1, 'failed', 3, NOW() + INTERVAL '1 hour')`, failed); err != nil {
		t.Fatal(err)
	}

	token, _, err := sessions.Create(ctx, owner, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	queued := func() (int, string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/playlists/"+playlist.ID.String()+"/tracks", nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		var body struct {
			Tracks       []json.RawMessage `json:"tracks"`
			TIDALQueued  *int              `json:"tidal_queued"`
			TIDALRetryAt string            `json:"tidal_retry_at"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("tracks: %d %s", rec.Code, rec.Body)
		}
		if len(body.Tracks) != 2 || body.TIDALQueued == nil {
			t.Fatalf("tracks response = %s", rec.Body)
		}
		return *body.TIDALQueued, body.TIDALRetryAt
	}

	// Not opted in: nothing is queued for this playlist.
	if got, retry := queued(); got != 0 || retry != "" {
		t.Fatalf("without auto-download = %d, %q; want 0 and no retry", got, retry)
	}
	if err := pls.SetTIDALAutoDownload(ctx, playlist.ID, true); err != nil {
		t.Fatal(err)
	}
	var retryAt time.Time
	if err := pool.QueryRow(ctx, `SELECT next_attempt_at FROM tidal_downloads WHERE tidal_id = $1`, failed).Scan(&retryAt); err != nil {
		t.Fatal(err)
	}
	got, retry := queued()
	if got != 1 || retry != retryAt.UTC().Format(time.RFC3339) {
		t.Fatalf("with one failed = %d, %q; want 1 and %s", got, retry, retryAt.UTC().Format(time.RFC3339))
	}
	// Its backoff runs out: the worker retries it, so it counts again.
	if _, err := pool.Exec(ctx, `UPDATE tidal_downloads SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE tidal_id = $1`, failed); err != nil {
		t.Fatal(err)
	}
	if got, retry := queued(); got != 2 || retry != "" {
		t.Fatalf("with the retry due = %d, %q; want 2 and no retry", got, retry)
	}
}
