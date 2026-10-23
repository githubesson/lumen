package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpapi/handlers"
	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/tidal"
)

// A track's detail says what its list rows say, so the track menu and Track
// Info offer the same actions: owned for the viewer's own upload (Delete),
// unavailable for a TIDAL track TIDAL dropped from its release (no Play).
func TestTrackDetailOwnedAndUnavailable(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	owner, other := redteamUser(t, ctx, pool), redteamUser(t, ctx, pool)
	upload := redteamTrack(t, ctx, pool, &owner, nil)
	shared := redteamTrack(t, ctx, pool, nil, nil)

	run := uuid.NewString()[:8]
	release, dropped, listed := "rel"+run, "drop"+run, "keep"+run
	remote := func(id string) uuid.UUID {
		t.Helper()
		row, err := lib.UpsertRemoteTrack(ctx, library.RemoteTrackInput{
			Source: "tidal", ExternalID: id, Title: "Song " + id, ArtistNames: []string{"Band " + run},
			AlbumTitle: "Record " + run, DurationMS: 1000, Metadata: map[string]any{"album_id": release},
		})
		if err != nil {
			t.Fatal(err)
		}
		return row
	}
	droppedRow, listedRow := remote(dropped), remote(listed)
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM tracks WHERE id = ANY($1)`, []uuid.UUID{droppedRow, listedRow})
		pool.Exec(c, `DELETE FROM tidal_albums WHERE tidal_id = $1`, release)
	})
	album := tidal.Album{ID: release, Title: "Record " + run, Artist: "Band " + run, TrackCount: 2, Tracks: []tidal.Track{
		{ID: dropped, Title: "Song " + dropped, TrackNo: 1, DurationMS: 1000},
		{ID: listed, Title: "Song " + listed, TrackNo: 2, DurationMS: 1000},
	}}
	if err := lib.SaveTIDALAlbum(ctx, album); err != nil {
		t.Fatal(err)
	}

	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := chi.NewRouter()
	router.Use(middleware.Authenticate(sessions), middleware.RequireUser)
	router.Get("/tracks/{id}", (&handlers.Tracks{Library: lib}).Get)
	type flags struct {
		Source      string `json:"source"`
		Owned       bool   `json:"owned"`
		Unavailable bool   `json:"unavailable"`
	}
	get := func(viewer, id uuid.UUID) (flags, int) {
		t.Helper()
		token, _, err := sessions.Create(ctx, viewer, httptest.NewRequest(http.MethodGet, "/", nil))
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodGet, "/tracks/"+id.String(), nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		var f flags
		if rec.Code == http.StatusOK {
			if err := json.Unmarshal(rec.Body.Bytes(), &f); err != nil {
				t.Fatal(err)
			}
		}
		return f, rec.Code
	}

	if f, code := get(owner, upload); code != http.StatusOK || !f.Owned {
		t.Fatalf("owner's upload: %d %+v, want owned", code, f)
	}
	if _, code := get(other, upload); code != http.StatusNotFound {
		t.Fatalf("someone else's upload: %d, want 404", code)
	}
	if f, code := get(owner, shared); code != http.StatusOK || f.Owned {
		t.Fatalf("shared track: %d %+v, want not owned", code, f)
	}

	// Both still listed: both play.
	for _, row := range []uuid.UUID{droppedRow, listedRow} {
		if f, code := get(other, row); code != http.StatusOK || f.Source != "tidal" || f.Unavailable {
			t.Fatalf("listed TIDAL track: %d %+v, want available", code, f)
		}
	}
	// TIDAL stops listing one: only that one is unavailable.
	album.Tracks, album.TrackCount = album.Tracks[1:], 1
	if err := lib.SaveTIDALAlbum(ctx, album); err != nil {
		t.Fatal(err)
	}
	if f, code := get(other, droppedRow); code != http.StatusOK || !f.Unavailable {
		t.Fatalf("dropped TIDAL track: %d %+v, want unavailable", code, f)
	}
	if f, code := get(other, listedRow); code != http.StatusOK || f.Unavailable {
		t.Fatalf("listed TIDAL track: %d %+v, want available", code, f)
	}
}

// A release first saved without tracks stored them as JSON null. Reading
// whether one of its tracks was dropped must not fail the track's detail,
// and a release saved without tracks now stores an empty list.
func TestTrackDetailWithTracklessRelease(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	viewer := redteamUser(t, ctx, pool)
	run := uuid.NewString()[:8]
	legacy, fresh, track := "nullrel"+run, "emptyrel"+run, "nulltrack"+run
	row, err := lib.UpsertRemoteTrack(ctx, library.RemoteTrackInput{
		Source: "tidal", ExternalID: track, Title: "Song " + run, ArtistNames: []string{"Band " + run},
		AlbumTitle: "Record " + run, DurationMS: 1000, Metadata: map[string]any{"album_id": legacy},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM tracks WHERE id = $1`, row)
		pool.Exec(c, `DELETE FROM tidal_albums WHERE tidal_id = ANY($1)`, []string{legacy, fresh})
	})
	if _, err := pool.Exec(ctx, `INSERT INTO tidal_albums (tidal_id, title, tracks) VALUES ($1, 'Record', 'null'::jsonb)`, legacy); err != nil {
		t.Fatal(err)
	}

	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	token, _, err := sessions.Create(ctx, viewer, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(middleware.Authenticate(sessions), middleware.RequireUser)
	router.Get("/tracks/{id}", (&handlers.Tracks{Library: lib}).Get)
	req := httptest.NewRequest(http.MethodGet, "/tracks/"+row.String(), nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: token})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	var got struct {
		Source      string `json:"source"`
		Unavailable *bool  `json:"unavailable"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &got) != nil {
		t.Fatalf("GET track under a null-tracks release: %d %s", rec.Code, rec.Body)
	}
	// omitempty: absent means false.
	if got.Source != "tidal" || got.Unavailable != nil {
		t.Fatalf("detail = %s, want an available TIDAL track", rec.Body)
	}

	if err := lib.SaveTIDALAlbum(ctx, tidal.Album{ID: fresh, Title: "Empty " + run}); err != nil {
		t.Fatal(err)
	}
	var kind string
	if err := pool.QueryRow(ctx, `SELECT jsonb_typeof(tracks) FROM tidal_albums WHERE tidal_id = $1`, fresh).Scan(&kind); err != nil {
		t.Fatal(err)
	}
	if kind != "array" {
		t.Fatalf("a release saved without tracks stores %s, want array", kind)
	}
}
