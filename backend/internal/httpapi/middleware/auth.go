package middleware

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/models"
)

const authenticationTimeout = 10 * time.Second

type sessionAuthenticator interface {
	CookieName() string
	LookupUser(context.Context, string) (auth.SessionInfo, *models.User, error)
	ClearCookie(http.ResponseWriter)
}

type apiKeyAuthenticator interface {
	LookupUser(context.Context, string) (uuid.UUID, *models.User, error)
}

type ctxKey int

const (
	ctxUser ctxKey = iota
	ctxSessionToken
	ctxAPIKey
)

func UserFromContext(ctx context.Context) (*models.User, bool) {
	u, ok := ctx.Value(ctxUser).(*models.User)
	return u, ok
}

func SessionTokenFromContext(ctx context.Context) (string, bool) {
	t, ok := ctx.Value(ctxSessionToken).(string)
	return t, ok
}

// APIKeyFromContext returns the id of the API key that authenticated the
// request, if one did.
func APIKeyFromContext(ctx context.Context) (uuid.UUID, bool) {
	id, ok := ctx.Value(ctxAPIKey).(uuid.UUID)
	return id, ok
}

// bearerAPIKey returns the API key in an `Authorization: Bearer lumen_…`
// header. Other Authorization headers (a proxy's own bearer token, Basic
// auth in front of the server) aren't for us and are left alone.
func bearerAPIKey(r *http.Request) (string, bool) {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	if !strings.HasPrefix(token, auth.APIKeyPrefix) {
		return "", false
	}
	return token, true
}

// AuthenticateAPIKey loads the user from an `Authorization: Bearer lumen_…`
// header, if present. Mount it before Authenticate, which then leaves the
// request alone. A key that doesn't work is refused rather than treated as
// no key, so a script with a revoked key fails loudly.
func AuthenticateAPIKey(keys apiKeyAuthenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key, ok := bearerAPIKey(r)
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			refuse := func() {
				w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
				http.Error(w, "invalid API key", http.StatusUnauthorized)
			}
			authCtx, cancel := context.WithTimeout(r.Context(), authenticationTimeout)
			id, u, err := keys.LookupUser(authCtx, key)
			cancel()
			if err != nil {
				if errors.Is(err, auth.ErrAPIKeyNotFound) {
					refuse()
					return
				}
				if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
					return
				}
				slog.Error("api key lookup failed", "err", err)
				w.Header().Set("Retry-After", "5")
				http.Error(w, "authentication service unavailable", http.StatusServiceUnavailable)
				return
			}
			if u.Disabled {
				refuse()
				return
			}
			ctx := context.WithValue(r.Context(), ctxUser, u)
			ctx = context.WithValue(ctx, ctxAPIKey, id)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// Authenticate loads the user from the session cookie, if present. It does
// not reject unauthenticated requests — that's RequireUser / RequireAdmin.
// A request an API key authenticated keeps that user and ignores the cookie.
func Authenticate(ss sessionAuthenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, ok := APIKeyFromContext(r.Context()); ok {
				next.ServeHTTP(w, r)
				return
			}
			cookie, err := r.Cookie(ss.CookieName())
			if err != nil || cookie.Value == "" {
				next.ServeHTTP(w, r)
				return
			}
			authCtx, cancel := context.WithTimeout(r.Context(), authenticationTimeout)
			_, u, err := ss.LookupUser(authCtx, cookie.Value)
			cancel()
			if err != nil {
				if errors.Is(err, auth.ErrSessionNotFound) {
					ss.ClearCookie(w)
					next.ServeHTTP(w, r)
					return
				}
				if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
					return
				}
				slog.Error("session lookup failed", "err", err)
				w.Header().Set("Retry-After", "5")
				http.Error(w, "authentication service unavailable", http.StatusServiceUnavailable)
				return
			}
			if u.Disabled {
				ss.ClearCookie(w)
				next.ServeHTTP(w, r)
				return
			}
			ctx := context.WithValue(r.Context(), ctxUser, u)
			ctx = context.WithValue(ctx, ctxSessionToken, cookie.Value)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireSession refuses requests an API key authenticated, for what only a
// signed-in app may do: manage API keys, change the password, sign out, hold
// the playback socket. A leaked key can't make more keys or lock its owner
// out. Mount it after RequireUser.
func RequireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := SessionTokenFromContext(r.Context()); !ok {
			if _, viaKey := APIKeyFromContext(r.Context()); viaKey {
				http.Error(w, "API keys can't do this; sign in to the app", http.StatusForbidden)
				return
			}
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := UserFromContext(r.Context())
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// A forced reset still allows session discovery and sign-out.
		if u.MustResetPassword && !((r.Method == http.MethodPost && (r.URL.Path == "/api/auth/reset-password" || r.URL.Path == "/api/auth/logout")) || (r.Method == http.MethodGet && r.URL.Path == "/api/auth/me")) {
			http.Error(w, "password reset required", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := UserFromContext(r.Context())
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if u.Role != models.RoleAdmin {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
