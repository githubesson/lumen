package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/models"
)

type fakeSessionAuthenticator struct {
	lookup func(context.Context, string) (auth.SessionInfo, *models.User, error)
}

func (f fakeSessionAuthenticator) CookieName() string              { return "session" }
func (f fakeSessionAuthenticator) ClearCookie(http.ResponseWriter) {}
func (f fakeSessionAuthenticator) LookupUser(ctx context.Context, token string) (auth.SessionInfo, *models.User, error) {
	return f.lookup(ctx, token)
}

func TestAuthenticateReturnsUnavailableOnLookupDeadline(t *testing.T) {
	ss := fakeSessionAuthenticator{lookup: func(ctx context.Context, _ string) (auth.SessionInfo, *models.User, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("session lookup context has no deadline")
		}
		return auth.SessionInfo{}, nil, context.DeadlineExceeded
	}}
	nextCalled := false
	h := Authenticate(ss)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		nextCalled = true
	}))
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(&http.Cookie{Name: "session", Value: "token"})
	w := httptest.NewRecorder()

	h.ServeHTTP(w, r)
	if nextCalled {
		t.Fatal("next handler was called after authentication cancellation")
	}
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
}

func TestAuthenticateContinuesForUnknownSession(t *testing.T) {
	ss := fakeSessionAuthenticator{lookup: func(context.Context, string) (auth.SessionInfo, *models.User, error) {
		return auth.SessionInfo{}, nil, auth.ErrSessionNotFound
	}}
	nextCalled := false
	h := Authenticate(ss)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		nextCalled = true
	}))
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(&http.Cookie{Name: "session", Value: "unknown"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if !nextCalled {
		t.Fatal("unknown session did not continue anonymously")
	}
}
