package handlers

// Shared request/response plumbing for the admin "pinned download source"
// endpoints (filen, artistgrid, apitracker). The three sources expose the same
// List/Add/Patch/Delete/Scan/Downloads surface against different stores; the
// helpers here hold the wire behavior (messages and status codes) in one place
// so the sources cannot drift apart.

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/githubesson/lumen/internal/pathsafe"
)

// pathPinID parses the {id} URL parameter for the admin pin endpoints,
// preserving their distinctive `bad pin id "<raw>"` 400 message.
func pathPinID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	rawID := chi.URLParam(r, "id")
	id, err := uuid.Parse(rawID)
	if err != nil {
		http.Error(w, "bad pin id "+strconv.Quote(rawID), http.StatusBadRequest)
		return uuid.Nil, false
	}
	return id, true
}

// listPins implements the admin pin list endpoint: load all pins, map each
// through the source-specific response builder, reply 200.
func listPins[P any, R any](w http.ResponseWriter, r *http.Request, list func(context.Context) ([]P, error), resp func(P) R) {
	pins, err := list(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := make([]R, 0, len(pins))
	for _, p := range pins {
		out = append(out, resp(p))
	}
	writeJSON(w, http.StatusOK, out)
}

// deletePin implements the admin pin delete endpoint. notFound is the source
// package's ErrNotFound sentinel.
func deletePin(w http.ResponseWriter, r *http.Request, notFound error, del func(context.Context, uuid.UUID) error) {
	id, ok := pathPinID(w, r)
	if !ok {
		return
	}
	if err := del(r.Context(), id); err != nil {
		if errors.Is(err, notFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// scanPinNow implements the admin "scan now" endpoint. start must be nil when
// the source's scanner is not wired (callers do the typed-nil check so a nil
// *Scanner never hides inside the func value).
func scanPinNow(w http.ResponseWriter, r *http.Request, notFound error, start func(context.Context, uuid.UUID) (bool, error)) {
	id, ok := pathPinID(w, r)
	if !ok {
		return
	}
	if start == nil {
		http.Error(w, "scanner not configured", http.StatusServiceUnavailable)
		return
	}
	started, err := start(context.WithoutCancel(r.Context()), id)
	if err != nil {
		if errors.Is(err, notFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if !started {
		http.Error(w, "scan already in progress", http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// listPinDownloads implements the admin pin download-history endpoint.
func listPinDownloads[D any](w http.ResponseWriter, r *http.Request, list func(context.Context, uuid.UUID, int) ([]D, error)) {
	id, ok := pathPinID(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	rows, err := list(r.Context(), id, limit)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// writePinAddError maps an AddPin failure to a status: 400 when the message
// carries one of the source's validation markers (e.g. "already pinned",
// "scan_interval"), 500 otherwise. The raw error text is the response body,
// matching the original inline mapping.
func writePinAddError(w http.ResponseWriter, err error, badRequestMarkers ...string) {
	status := http.StatusInternalServerError
	for _, marker := range badRequestMarkers {
		if strings.Contains(err.Error(), marker) {
			status = http.StatusBadRequest
			break
		}
	}
	http.Error(w, err.Error(), status)
}

// resolvePatchSubdir validates a destination_subdir patch in place: when the
// patch carries a subdir it is cleaned against the pin's root (loaded through
// rootPath). Returns false if a response has already been written.
func resolvePatchSubdir(w http.ResponseWriter, r *http.Request, id uuid.UUID, notFound error, rootPath func(context.Context, uuid.UUID) (string, error), subdir **string) bool {
	if *subdir == nil {
		return true
	}
	root, err := rootPath(r.Context(), id)
	if err != nil {
		if errors.Is(err, notFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return false
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return false
	}
	clean, err := cleanPinSubdir(root, **subdir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return false
	}
	*subdir = &clean
	return true
}

// resolvePinRoot maps an Add request's root_id/root_path pair onto a
// configured music root: an explicit root_id wins, an empty pair falls back to
// the primary root, and a root_path must match the primary root or a
// registered source root.
func resolvePinRoot(r *http.Request, roots *musicroots.Store, primaryRoot, rootIDRaw, rootPathRaw string) (*uuid.UUID, string, error) {
	rootIDRaw = strings.TrimSpace(rootIDRaw)
	rootPathRaw = strings.TrimSpace(rootPathRaw)
	primaryAbs, _ := filepath.Abs(primaryRoot)
	if rootIDRaw != "" {
		id, err := uuid.Parse(rootIDRaw)
		if err != nil {
			return nil, "", errors.New("bad root_id")
		}
		root, err := roots.Get(r.Context(), id)
		if err != nil {
			if errors.Is(err, musicroots.ErrNotFound) {
				return nil, "", errors.New("root_id does not exist")
			}
			return nil, "", errors.New("cannot load root")
		}
		return &id, root.Path, nil
	}
	if rootPathRaw == "" {
		return nil, primaryAbs, nil
	}
	rootAbs, err := filepath.Abs(rootPathRaw)
	if err != nil {
		return nil, "", errors.New("invalid root_path")
	}
	if samePath(rootAbs, primaryAbs) {
		return nil, primaryAbs, nil
	}
	all, err := roots.List(r.Context())
	if err != nil {
		return nil, "", errors.New("cannot load roots")
	}
	for _, root := range all {
		abs, _ := filepath.Abs(root.Path)
		if samePath(rootAbs, abs) {
			id := root.ID
			return &id, root.Path, nil
		}
	}
	return nil, "", errors.New("root_path must match an existing source root")
}

func cleanPinSubdir(root, subdir string) (string, error) {
	subdir = strings.TrimSpace(subdir)
	if subdir == "" || subdir == "." {
		return "", nil
	}
	if filepath.IsAbs(subdir) {
		return "", errors.New("destination_subdir must be relative")
	}
	if _, err := pathsafe.CleanSubdir(root, subdir); err != nil {
		return "", errors.New("destination_subdir escapes root")
	}
	return filepath.Clean(subdir), nil
}

func cleanStringPtr(p *string) {
	if p != nil {
		*p = strings.TrimSpace(*p)
	}
}

func samePath(a, b string) bool {
	rel, err := filepath.Rel(a, b)
	return err == nil && rel == "."
}
