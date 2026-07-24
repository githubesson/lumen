package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/models"
	"github.com/githubesson/lumen/internal/playlists"
)

var errFileTooLarge = errors.New("file too large")

// JSON API payloads are metadata, never media. Keep a shared upper bound so a
// forgotten handler-specific limit cannot make the decoder consume an
// unbounded request. Auth and optional-body endpoints intentionally use their
// own smaller/custom decode policies.
const (
	maxJSONBodyBytes   int64 = 1 << 20
	maxJSONStringBytes       = 64 << 10
)

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

// pageParams returns the limit/offset pagination query parameters. Missing or
// malformed values come back as zero; each store applies its own default and
// cap, so no clamping happens here.
func pageParams(q url.Values) (limit, offset int) {
	limit, _ = strconv.Atoi(q.Get("limit"))
	offset, _ = strconv.Atoi(q.Get("offset"))
	return limit, offset
}

// writeJSON encodes v as the response body with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// decodeJSON decodes exactly one JSON value into dst. On failure it writes the
// response and returns false so the caller can simply `return`. Handlers with
// a different decode policy (auth's smaller body limit, invites' EOF-tolerant
// optional body) keep their own logic.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(dst); err != nil {
		writeJSONDecodeError(w, err)
		return false
	}
	if err := validateJSONValue(reflect.ValueOf(dst)); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return false
	}
	// Only whitespace may follow the first value. Decoding into an empty
	// struct avoids retaining a second, potentially large JSON value.
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeJSONDecodeError(w, err)
		return false
	}
	return true
}

// decodeOptionalJSON is decodeJSON for endpoints whose body may legitimately be
// omitted: an empty body succeeds and leaves dst at its zero value. Everything
// else — the 1 MiB cap, the string-length check, the trailing-value rejection —
// is identical, so an optional body is never an unbounded read.
func decodeOptionalJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return true
		}
		writeJSONDecodeError(w, err)
		return false
	}
	if err := validateJSONValue(reflect.ValueOf(dst)); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSONDecodeError(w, err)
		return false
	}
	return true
}

func validateJSONValue(v reflect.Value) error {
	if !v.IsValid() {
		return nil
	}
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if v.IsNil() {
			return nil
		}
		return validateJSONValue(v.Elem())
	case reflect.String:
		if v.Len() > maxJSONStringBytes {
			return errors.New("JSON string too large")
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < v.Len(); i++ {
			if err := validateJSONValue(v.Index(i)); err != nil {
				return err
			}
		}
	case reflect.Map:
		iter := v.MapRange()
		for iter.Next() {
			if err := validateJSONValue(iter.Key()); err != nil {
				return err
			}
			if err := validateJSONValue(iter.Value()); err != nil {
				return err
			}
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if err := validateJSONValue(v.Field(i)); err != nil {
				return err
			}
		}
	}
	return nil
}

func writeJSONDecodeError(w http.ResponseWriter, err error) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		return
	}
	http.Error(w, "bad request", http.StatusBadRequest)
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
	case errors.Is(err, library.ErrInvalidInput):
		// Only genuine caller mistakes get 400. A pgx reset or a context
		// deadline must not be reported as a malformed request — the client
		// would never retry and the edit would be silently lost.
		http.Error(w, err.Error(), http.StatusBadRequest)
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
