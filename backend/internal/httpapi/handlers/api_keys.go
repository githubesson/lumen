package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpapi/middleware"
)

// APIKeys lets a signed-in user make, list and revoke the keys scripts use
// to call the API as them. The router mounts it behind RequireSession: a key
// can't manage keys.
type APIKeys struct {
	Store *auth.APIKeyStore
}

const (
	maxAPIKeyNameRunes  = 100
	maxAPIKeyExpiryDays = 3650
)

type createAPIKeyReq struct {
	Name string `json:"name"`
	// 0 or absent: the key lasts until it's deleted.
	ExpiresInDays int `json:"expires_in_days"`
}

type createAPIKeyResp struct {
	auth.APIKey
	// The key itself, shown this once.
	Key string `json:"key"`
}

func (h *APIKeys) List(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	keys, err := h.Store.List(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if keys == nil {
		keys = []auth.APIKey{}
	}
	writeJSON(w, http.StatusOK, keys)
}

func (h *APIKeys) Create(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	session, ok := middleware.SessionTokenFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req createAPIKeyReq
	if !decodeJSON(w, r, &req) {
		return
	}
	name, ok := normalizeAPIKeyName(req.Name)
	if !ok {
		http.Error(w, fmt.Sprintf("name must be 1-%d characters", maxAPIKeyNameRunes), http.StatusBadRequest)
		return
	}
	if req.ExpiresInDays < 0 || req.ExpiresInDays > maxAPIKeyExpiryDays {
		http.Error(w, fmt.Sprintf("expires_in_days must be 0 (never) to %d", maxAPIKeyExpiryDays), http.StatusBadRequest)
		return
	}
	var expiresAt *time.Time
	if req.ExpiresInDays > 0 {
		t := time.Now().AddDate(0, 0, req.ExpiresInDays)
		expiresAt = &t
	}
	plain, key, err := h.Store.Create(r.Context(), u.ID, auth.HashToken(session), name, expiresAt)
	if errors.Is(err, auth.ErrSignedOut) {
		// Signed out (or disabled) while the request was on its way.
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if errors.Is(err, auth.ErrTooManyAPIKeys) {
		http.Error(w, fmt.Sprintf("you have %d API keys, the most allowed; delete one first", auth.MaxAPIKeysPerUser), http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, createAPIKeyResp{APIKey: key, Key: plain})
}

func (h *APIKeys) Delete(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	if err := h.Store.Delete(r.Context(), u.ID, id); err != nil {
		if errors.Is(err, auth.ErrAPIKeyNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// normalizeAPIKeyName trims a key's name and refuses an empty or overlong
// one, control characters, text-direction overrides (they reorder how the
// list and the confirm card show it), and a name with nothing visible in it
// (only zero-width characters). Joiners inside emoji stay allowed.
func normalizeAPIKeyName(raw string) (string, bool) {
	name := strings.TrimSpace(raw)
	if name == "" || utf8.RuneCountInString(name) > maxAPIKeyNameRunes {
		return "", false
	}
	visible := false
	for _, r := range name {
		if unicode.IsControl(r) || isBidiControl(r) {
			return "", false
		}
		if !unicode.IsSpace(r) && !unicode.Is(unicode.Cf, r) {
			visible = true
		}
	}
	if !visible {
		return "", false
	}
	return name, true
}

// isBidiControl reports the embedding, override and isolate characters.
func isBidiControl(r rune) bool {
	return (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
}
