package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/models"
	"github.com/githubesson/lumen/internal/playlists"
)

var errFileTooLarge = errors.New("file too large")

func copyFileLimited(dst io.Writer, src io.Reader, maxBytes int64) (int64, error) {
	limited := &io.LimitedReader{R: src, N: maxBytes + 1}
	n, err := io.Copy(dst, limited)
	if err != nil {
		return n, err
	}
	if n > maxBytes {
		return n, errFileTooLarge
	}
	return n, nil
}

func zeroTime() time.Time { return time.Time{} }

// writeJSON encodes v as the response body with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// decodeJSON decodes the request body into dst. On failure it writes the
// standard "bad request" 400 and returns false so the caller can simply
// `return`. Handlers with a different decode policy (auth's MaxBytes-aware
// decodeBody, invites' EOF-tolerant optional body) keep their own logic.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return false
	}
	return true
}

// pathUUID parses a UUID from the chi URL parameter named `name`. On a parse
// failure it writes a 400 ("bad <name>") and returns ok=false so the caller can
// simply `return`.
func pathUUID(w http.ResponseWriter, r *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, name))
	if err != nil {
		http.Error(w, "bad "+name, http.StatusBadRequest)
		return uuid.Nil, false
	}
	return id, true
}

// writeStoreError maps a store-layer error to an HTTP response: a not-found
// sentinel (library or playlists) becomes 404, anything else 500. Call it only
// once the caller has confirmed err != nil.
func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, library.ErrNotFound), errors.Is(err, playlists.ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	default:
		http.Error(w, "internal error", http.StatusInternalServerError)
	}
}

// requireUser returns the authenticated user from the request context. For
// handlers mounted behind the auth middleware the user is always present; this
// is the safety net that writes 401 and returns ok=false instead of letting a
// caller dereference a nil *models.User if a route is ever mis-mounted.
func requireUser(w http.ResponseWriter, r *http.Request) (*models.User, bool) {
	u, ok := middleware.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return nil, false
	}
	return u, true
}
