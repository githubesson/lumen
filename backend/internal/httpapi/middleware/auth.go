package middleware

import (
	"context"
	"errors"
	"net/http"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/models"
	"github.com/githubesson/lumen/internal/users"
)

type ctxKey int

const (
	ctxUser ctxKey = iota
	ctxSessionToken
)

func UserFromContext(ctx context.Context) (*models.User, bool) {
	u, ok := ctx.Value(ctxUser).(*models.User)
	return u, ok
}

func SessionTokenFromContext(ctx context.Context) (string, bool) {
	t, ok := ctx.Value(ctxSessionToken).(string)
	return t, ok
}

// Authenticate loads the user from the session cookie, if present. It does
// not reject unauthenticated requests — that's RequireUser / RequireAdmin.
func Authenticate(ss *auth.SessionStore, usersStore *users.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cookie, err := r.Cookie(ss.CookieName())
			if err != nil || cookie.Value == "" {
				next.ServeHTTP(w, r)
				return
			}
			info, err := ss.Lookup(r.Context(), cookie.Value)
			if err != nil {
				if errors.Is(err, auth.ErrSessionNotFound) {
					ss.ClearCookie(w)
				}
				next.ServeHTTP(w, r)
				return
			}
			u, err := usersStore.ByID(r.Context(), info.UserID)
			if err != nil {
				next.ServeHTTP(w, r)
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

func RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := UserFromContext(r.Context())
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// Users mid-forced-reset can only hit POST /auth/reset-password.
		if u.MustResetPassword && !(r.Method == http.MethodPost && r.URL.Path == "/api/auth/reset-password") {
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
