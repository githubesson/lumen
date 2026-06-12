package auth

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrSessionNotFound = errors.New("session not found")

type SessionStore struct {
	db         *pgxpool.Pool
	cookieName string
	secure     bool
	ttl        time.Duration
}

func NewSessionStore(db *pgxpool.Pool, cookieName string, secure bool, ttl time.Duration) *SessionStore {
	return &SessionStore{db: db, cookieName: cookieName, secure: secure, ttl: ttl}
}

type SessionInfo struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	ExpiresAt time.Time
}

func (s *SessionStore) Create(ctx context.Context, userID uuid.UUID, r *http.Request) (plain string, info SessionInfo, err error) {
	plain, hash, err := RandomToken(32)
	if err != nil {
		return "", SessionInfo{}, err
	}
	expires := time.Now().Add(s.ttl)
	ip := clientIP(r)
	var ipArg any
	if ip != "" {
		ipArg = ip
	} // else nil — Postgres accepts NULL into INET
	var id uuid.UUID
	err = s.db.QueryRow(ctx, `
		INSERT INTO sessions (token_hash, user_id, user_agent, ip, expires_at)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id`,
		hash, userID, r.UserAgent(), ipArg, expires,
	).Scan(&id)
	if err != nil {
		return "", SessionInfo{}, err
	}
	return plain, SessionInfo{ID: id, UserID: userID, ExpiresAt: expires}, nil
}

func (s *SessionStore) Lookup(ctx context.Context, plain string) (SessionInfo, error) {
	hash := HashToken(plain)
	var info SessionInfo
	err := s.db.QueryRow(ctx, `
		SELECT id, user_id, expires_at FROM sessions
		WHERE token_hash = $1 AND expires_at > NOW()`, hash,
	).Scan(&info.ID, &info.UserID, &info.ExpiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SessionInfo{}, ErrSessionNotFound
		}
		return SessionInfo{}, err
	}
	_, _ = s.db.Exec(ctx, `UPDATE sessions SET last_seen_at = NOW() WHERE id = $1`, info.ID)
	return info, nil
}

func (s *SessionStore) Revoke(ctx context.Context, plain string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, HashToken(plain))
	return err
}

func (s *SessionStore) RevokeAllForUser(ctx context.Context, userID uuid.UUID) error {
	_, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
	return err
}

func (s *SessionStore) SetCookie(w http.ResponseWriter, plain string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName,
		Value:    plain,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  expires,
	})
}

func (s *SessionStore) ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func (s *SessionStore) CookieName() string { return s.cookieName }

// clientIP returns a bare IP (no port) suitable for a Postgres INET column.
// Falls back to "" if nothing usable is available. Reads only r.RemoteAddr —
// the trusted-proxy middleware is responsible for setting that to the real
// client address (and stripping spoofed XFF/X-Real-IP from untrusted peers).
func clientIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		if ip := net.ParseIP(host); ip != nil {
			return ip.String()
		}
	}
	if ip := net.ParseIP(r.RemoteAddr); ip != nil {
		return ip.String()
	}
	return ""
}
