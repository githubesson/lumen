package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/library"
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
