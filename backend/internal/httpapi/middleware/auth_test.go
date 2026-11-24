package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

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

type fakeAPIKeyAuthenticator struct {
	lookup func(context.Context, string) (uuid.UUID, *models.User, error)
}

func (f fakeAPIKeyAuthenticator) LookupUser(ctx context.Context, key string) (uuid.UUID, *models.User, error) {
	return f.lookup(ctx, key)
}

func TestAuthenticateAPIKey(t *testing.T) {
	keyID := uuid.New()
	user := &models.User{ID: uuid.New(), Username: "scripted"}
	keys := fakeAPIKeyAuthenticator{lookup: func(_ context.Context, key string) (uuid.UUID, *models.User, error) {
		switch key {
		case "lumen_good":
			return keyID, user, nil
		case "lumen_disabled":
			return keyID, &models.User{ID: uuid.New(), Disabled: true}, nil
		case "lumen_down":
			return uuid.Nil, nil, errors.New("db down")
		}
		return uuid.Nil, nil, auth.ErrAPIKeyNotFound
	}}
	sessionLookups := 0
	ss := fakeSessionAuthenticator{lookup: func(context.Context, string) (auth.SessionInfo, *models.User, error) {
		sessionLookups++
		return auth.SessionInfo{}, &models.User{ID: uuid.New()}, nil
	}}
	cases := []struct {
		name          string
		authorization string
		wantCode      int
		wantUser      bool
		wantKey       bool
	}{
		{"valid key", "Bearer lumen_good", http.StatusOK, true, true},
		{"scheme is case-insensitive", "bearer  lumen_good ", http.StatusOK, true, true},
		{"unknown key", "Bearer lumen_unknown", http.StatusUnauthorized, false, false},
		{"disabled user", "Bearer lumen_disabled", http.StatusUnauthorized, false, false},
		{"lookup failure", "Bearer lumen_down", http.StatusServiceUnavailable, false, false},
		{"another bearer token falls back to the cookie", "Bearer eyJhbGciOi", http.StatusOK, true, false},
		{"basic auth falls back to the cookie", "Basic dXNlcjpwYXNz", http.StatusOK, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sessionLookups = 0
			var gotUser, gotKey bool
			h := AuthenticateAPIKey(keys)(Authenticate(ss)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, gotUser = UserFromContext(r.Context())
				var id uuid.UUID
				id, gotKey = APIKeyFromContext(r.Context())
				if gotKey && id != keyID {
					t.Errorf("key id = %s, want %s", id, keyID)
				}
			})))
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.Header.Set("Authorization", c.authorization)
			r.AddCookie(&http.Cookie{Name: "session", Value: "token"})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != c.wantCode || gotUser != c.wantUser || gotKey != c.wantKey {
				t.Fatalf("code %d user %v key %v, want %d %v %v", w.Code, gotUser, gotKey, c.wantCode, c.wantUser, c.wantKey)
			}
			if c.wantKey && sessionLookups != 0 {
				t.Fatal("a key-authenticated request also looked up the session")
			}
			if c.wantCode == http.StatusUnauthorized && !strings.Contains(w.Header().Get("WWW-Authenticate"), "invalid_token") {
				t.Fatalf("WWW-Authenticate = %q", w.Header().Get("WWW-Authenticate"))
			}
		})
	}
}

func TestRequireSession(t *testing.T) {
	h := RequireSession(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	user := &models.User{ID: uuid.New()}
	cases := []struct {
		name string
		ctx  func(context.Context) context.Context
		want int
	}{
		{"session", func(ctx context.Context) context.Context {
			return context.WithValue(context.WithValue(ctx, ctxUser, user), ctxSessionToken, "t")
		}, http.StatusNoContent},
		{"api key", func(ctx context.Context) context.Context {
			return context.WithValue(context.WithValue(ctx, ctxUser, user), ctxAPIKey, uuid.New())
		}, http.StatusForbidden},
		{"anonymous", func(ctx context.Context) context.Context { return ctx }, http.StatusUnauthorized},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/", nil)
			r = r.WithContext(c.ctx(r.Context()))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != c.want {
				t.Fatalf("status = %d, want %d", w.Code, c.want)
			}
		})
	}
}
