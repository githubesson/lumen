package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/tidal"
)

// closedPool is a pool every query on fails, as when the database is
// unreachable: handlers must answer that with a server error, not a 4xx
// the client takes as the resource's final word.
func closedPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), "postgres://lumen@127.0.0.1:1/lumen")
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()
	return pool
}

// withURLParams sets chi URL parameters the way the router would.
func withURLParams(req *http.Request, kv ...string) *http.Request {
	rctx := chi.NewRouteContext()
	for i := 0; i+1 < len(kv); i += 2 {
		rctx.URLParams.Add(kv[i], kv[i+1])
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

// A failed cover lookup is a 500 for both kinds of signed URL. With `u=` it
// used to fall through to the remote lookup and 404, which Discord's media
// proxy then caches.
func TestPublicAlbumCoverReportsLookupFailure(t *testing.T) {
	key := []byte("test-signing-key")
	h := &Tracks{Library: library.NewStore(closedPool(t)), CoverSignKey: key}
	albumID, userID := uuid.New(), uuid.New()
	for _, user := range []*uuid.UUID{nil, &userID} {
		path, _ := signedAlbumCoverPath(key, albumID, user, time.Now())
		req := withURLParams(httptest.NewRequest(http.MethodGet, path, nil), "id", albumID.String())
		rec := httptest.NewRecorder()
		h.PublicAlbumCover(rec, req)
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("%s: status %d, want 500", path, rec.Code)
		}
	}
}

// Only a malformed id is the caller's mistake. A missing track, TIDAL
// failing and the server failing each get their own status, so a client
// retries what can be retried and drops what is gone.
func TestWriteTrackResolveErrorStatuses(t *testing.T) {
	_, badRef := resolveTrackRowID(context.Background(), nil, nil, uuid.New(), "not-a-track", false)
	_, refusal := refusingTIDAL(t, "Not in your region").Track(context.Background(), "1")
	for _, tc := range []struct {
		name   string
		err    error
		status int
		body   string
	}{
		{"malformed id", badRef, http.StatusBadRequest, "bad track id"},
		{"missing or not visible", library.ErrNotFound, http.StatusNotFound, "not found"},
		{"tidal not set up", tidal.ErrNotConfigured, http.StatusServiceUnavailable, "tidal proxy is not configured"},
		{"tidal refused", fmt.Errorf("%w: %w", errTIDALLookup, refusal), http.StatusBadGateway, "TIDAL refused this track: Not in your region"},
		{"tidal failed", fmt.Errorf("%w: %w", errTIDALLookup, errors.New("hifi-api request failed: 500")), http.StatusBadGateway, "tidal track lookup failed"},
		{"database", errors.New("closed pool"), http.StatusInternalServerError, "internal error"},
		{"deadline", context.DeadlineExceeded, http.StatusInternalServerError, "internal error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeTrackResolveError(rec, tc.err)
			if rec.Code != tc.status || rec.Body.String() != tc.body+"\n" {
				t.Fatalf("status=%d body=%q, want %d %q", rec.Code, rec.Body.String(), tc.status, tc.body)
			}
		})
	}
}

// A database failure resolving a track id used to come back as 400 "bad
// track id" from every endpoint taking one.
func TestTrackEndpointsReportResolveFailureAsServerError(t *testing.T) {
	h := &Tracks{Library: library.NewStore(closedPool(t))}
	for name, handler := range map[string]http.HandlerFunc{
		"favorite":    h.Favorite,
		"unfavorite":  h.Unfavorite,
		"get":         h.Get,
		"now playing": h.NowPlaying,
		"record play": h.RecordPlay,
	} {
		w := serveAuthenticated(t, "/api/tracks/{id}", handler, "/api/tracks/"+uuid.NewString())
		if w.Code != http.StatusInternalServerError {
			t.Errorf("%s: status %d, want 500", name, w.Code)
		}
		w = serveAuthenticated(t, "/api/tracks/{id}", handler, "/api/tracks/not-a-track")
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s with a malformed id: status %d, want 400", name, w.Code)
		}
	}
}

// A failed playlist lookup is a 500 on every playlist endpoint. Most of
// them used to answer 404, which clients take as the playlist being gone
// and drop it from their cache.
func TestPlaylistEndpointsReportLookupFailureAsServerError(t *testing.T) {
	h := &Playlists{Store: playlists.NewStore(closedPool(t)), Covers: &Tracks{}}
	for name, handler := range map[string]http.HandlerFunc{
		"get":                   h.Get,
		"update":                h.Update,
		"delete":                h.Delete,
		"cover":                 h.Cover,
		"put cover":             h.PutCover,
		"delete cover":          h.DeleteCover,
		"list tracks":           h.ListTracks,
		"add tracks":            h.AddTracks,
		"remove track":          h.RemoveTrack,
		"reorder":               h.Reorder,
		"list collaborators":    h.ListCollaborators,
		"invite collaborator":   h.InviteCollaborator,
		"remove collaborator":   h.RemoveCollaborator,
		"set collaborator role": h.SetCollaboratorRole,
	} {
		target := "/api/playlists/" + uuid.NewString() + "/x/" + uuid.NewString()
		w := serveAuthenticated(t, "/api/playlists/{id}/x/{user_id}", handler, target)
		if w.Code != http.StatusInternalServerError {
			t.Errorf("%s: status %d, want 500", name, w.Code)
		}
	}
}
