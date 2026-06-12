package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/uncut/lumen/internal/auth"
	"github.com/uncut/lumen/internal/dbutil"
	"github.com/uncut/lumen/internal/httpapi/middleware"
	"github.com/uncut/lumen/internal/invites"
	"github.com/uncut/lumen/internal/models"
	"github.com/uncut/lumen/internal/users"
)

type Auth struct {
	DB       *pgxpool.Pool
	Users    *users.Store
	Sessions *auth.SessionStore
	Invites  *invites.Store
}

// Auth payloads are tiny (a username + password). Cap body size so a hostile
// client can't stream gigabytes into the JSON decoder, and cap password length
// so a 1MB "password" doesn't sit in memory while we decide what to do with it.
const (
	maxAuthBodyBytes = 8 << 10
	maxPasswordLen   = 256
)

// decodeAuthJSON wraps the body in MaxBytesReader before decoding so oversized
// payloads return 413 instead of getting chewed through. Returns false (and
// writes the response) on any error — callers should just `return`.
func decodeAuthJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return false
		}
		http.Error(w, "bad request", http.StatusBadRequest)
		return false
	}
	return true
}

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type userResp struct {
	ID                string `json:"id"`
	Username          string `json:"username"`
	Role              string `json:"role"`
	MustResetPassword bool   `json:"must_reset_password"`
}

func toResp(u *models.User) userResp {
	return userResp{
		ID:                u.ID.String(),
		Username:          u.Username,
		Role:              string(u.Role),
		MustResetPassword: u.MustResetPassword,
	}
}

func (h *Auth) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if !decodeAuthJSON(w, r, &req) {
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || req.Password == "" || len(req.Password) > maxPasswordLen {
		// Spend the same Argon2id round-trip we'd spend on a real verify so
		// the timing of a malformed/empty submission matches a real miss.
		_, _ = auth.VerifyPassword(req.Password, auth.DummyHash())
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	u, err := h.Users.ByUsername(r.Context(), req.Username)
	if err != nil {
		// User doesn't exist — verify against a dummy hash so the response
		// time matches the "exists, wrong password" path. Otherwise an
		// attacker can enumerate valid usernames purely from timing.
		_, _ = auth.VerifyPassword(req.Password, auth.DummyHash())
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	ok, err := auth.VerifyPassword(req.Password, u.PasswordHash)
	if err != nil || !ok {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	// Disabled check happens *after* the password verify so we don't leak
	// "account exists and is disabled" to anyone who guesses a username.
	if u.Disabled {
		http.Error(w, "account disabled", http.StatusForbidden)
		return
	}
	if !h.issueSession(w, r, u.ID) {
		return
	}
	_ = h.Users.TouchLogin(r.Context(), u.ID, time.Now())
	writeJSON(w, http.StatusOK, toResp(u))
}

func (h *Auth) Logout(w http.ResponseWriter, r *http.Request) {
	if token, ok := middleware.SessionTokenFromContext(r.Context()); ok {
		_ = h.Sessions.Revoke(r.Context(), token)
	}
	h.Sessions.ClearCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Auth) Me(w http.ResponseWriter, r *http.Request) {
	u, ok := middleware.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, toResp(u))
}

type resetPasswordReq struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

func (h *Auth) ResetPassword(w http.ResponseWriter, r *http.Request) {
	u, ok := middleware.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req resetPasswordReq
	if !decodeAuthJSON(w, r, &req) {
		return
	}
	if len(req.NewPassword) < 8 {
		http.Error(w, "password too short (min 8 chars)", http.StatusBadRequest)
		return
	}
	if len(req.NewPassword) > maxPasswordLen {
		http.Error(w, "password too long", http.StatusBadRequest)
		return
	}
	if len(req.CurrentPassword) > maxPasswordLen {
		// Don't waste an Argon2 round on a payload we'd reject anyway.
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	ok, err := auth.VerifyPassword(req.CurrentPassword, u.PasswordHash)
	if err != nil || !ok {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := h.Users.UpdatePassword(r.Context(), u.ID, hash, true); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Invalidate all sessions (including current), then issue a fresh one.
	_ = h.Sessions.RevokeAllForUser(r.Context(), u.ID)
	if !h.issueSession(w, r, u.ID) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type registerReq struct {
	Token    string `json:"token"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func (h *Auth) Register(w http.ResponseWriter, r *http.Request) {
	var req registerReq
	if !decodeAuthJSON(w, r, &req) {
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if len(req.Username) < 2 || len(req.Password) < 8 || req.Token == "" {
		http.Error(w, "invalid registration", http.StatusBadRequest)
		return
	}
	if len(req.Password) > maxPasswordLen {
		http.Error(w, "password too long", http.StatusBadRequest)
		return
	}
	inv, err := h.Invites.LookupByToken(r.Context(), req.Token)
	if err != nil {
		http.Error(w, "invalid invite", http.StatusBadRequest)
		return
	}
	if !inv.Usable(time.Now()) {
		http.Error(w, "invite is no longer usable", http.StatusBadRequest)
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	tx, err := h.DB.BeginTx(r.Context(), pgx.TxOptions{})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback(r.Context())

	consumed, err := h.Invites.Consume(r.Context(), tx, inv.ID)
	if err != nil {
		if errors.Is(err, invites.ErrExhausted) {
			http.Error(w, "invite is no longer usable", http.StatusBadRequest)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	var uid string
	err = tx.QueryRow(r.Context(), `
		INSERT INTO users (username, password_hash, role, invite_id, must_reset_password)
		VALUES ($1, $2, $3, $4, FALSE)
		RETURNING id`, req.Username, hash, consumed.TargetRole, consumed.ID).Scan(&uid)
	if err != nil {
		if dbutil.IsUniqueViolation(err) {
			http.Error(w, "username taken", http.StatusConflict)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	u, err := h.Users.ByUsername(r.Context(), req.Username)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if !h.issueSession(w, r, u.ID) {
		return
	}
	writeJSON(w, http.StatusCreated, toResp(u))
}

type inviteCheckResp struct {
	Valid      bool   `json:"valid"`
	TargetRole string `json:"target_role,omitempty"`
}

func (h *Auth) CheckInvite(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		writeJSON(w, http.StatusOK, inviteCheckResp{Valid: false})
		return
	}
	inv, err := h.Invites.LookupByToken(r.Context(), token)
	if err != nil || !inv.Usable(time.Now()) {
		writeJSON(w, http.StatusOK, inviteCheckResp{Valid: false})
		return
	}
	writeJSON(w, http.StatusOK, inviteCheckResp{Valid: true, TargetRole: string(inv.TargetRole)})
}

// issueSession creates a session for uid and sets the session cookie. On
// failure it writes a 500 and returns false so callers can just `return`.
func (h *Auth) issueSession(w http.ResponseWriter, r *http.Request, uid uuid.UUID) bool {
	token, info, err := h.Sessions.Create(r.Context(), uid, r)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return false
	}
	h.Sessions.SetCookie(w, token, info.ExpiresAt)
	return true
}
