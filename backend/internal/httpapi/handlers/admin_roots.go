package handlers

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/uncut/lumen/internal/dbutil"
	"github.com/uncut/lumen/internal/ingest"
	"github.com/uncut/lumen/internal/library"
	"github.com/uncut/lumen/internal/musicroots"
)

// AdminRoots manages the set of extra music directories an admin can
// configure at runtime. The primary MUSIC_PATH is always included in scans
// but cannot be removed here — it is returned with a blank ID so the UI can
// show it alongside the user-managed rows.
type AdminRoots struct {
	Store       *musicroots.Store
	Library     *library.Store
	Ingest      *ingest.Service
	PrimaryRoot string
	Refresh     func()
}

type rootResp struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	Label     string `json:"label"`
	Enabled   bool   `json:"enabled"`
	Primary   bool   `json:"primary"`
	Exists    bool   `json:"exists"`
	CreatedAt string `json:"created_at,omitempty"`
}

func (h *AdminRoots) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Store.List(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := make([]rootResp, 0, len(rows)+1)
	out = append(out, rootResp{
		Path:    h.PrimaryRoot,
		Label:   "Primary (MUSIC_PATH)",
		Enabled: true,
		Primary: true,
		Exists:  dirExists(h.PrimaryRoot),
	})
	for _, r := range rows {
		out = append(out, rootResp{
			ID:        r.ID.String(),
			Path:      r.Path,
			Label:     r.Label,
			Enabled:   r.Enabled,
			Exists:    dirExists(r.Path),
			CreatedAt: r.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

type addRootReq struct {
	Path  string `json:"path"`
	Label string `json:"label"`
}

func (h *AdminRoots) Add(w http.ResponseWriter, r *http.Request) {
	var req addRootReq
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Path = strings.TrimSpace(req.Path)
	req.Label = strings.TrimSpace(req.Label)
	if req.Path == "" {
		http.Error(w, "path is required", http.StatusBadRequest)
		return
	}
	abs, err := filepath.Abs(req.Path)
	if err != nil {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	info, err := os.Stat(abs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "path does not exist on the server", http.StatusBadRequest)
			return
		}
		http.Error(w, "cannot access path", http.StatusBadRequest)
		return
	}
	if !info.IsDir() {
		http.Error(w, "path must be a directory", http.StatusBadRequest)
		return
	}
	// Nested and overlapping roots are safe: the watcher dedups directories
	// via its watch set and ingest dedups by audio hash, so a folder inside
	// the primary root (a common layout — /mnt/music/<artist>) won't
	// double-scan or create duplicate tracks. Only an exact duplicate is
	// rejected: a second row for the same path is a pointless, confusing
	// entry. Duplicates of an existing root are caught by the
	// music_roots.path UNIQUE constraint below; the primary root has no row,
	// so guard it explicitly here.
	if primaryAbs, perr := filepath.Abs(h.PrimaryRoot); perr == nil && abs == primaryAbs {
		http.Error(w, "that path is the primary music root", http.StatusBadRequest)
		return
	}

	row, err := h.Store.Add(r.Context(), abs, req.Label)
	if err != nil {
		if dbutil.IsUniqueViolation(err) {
			http.Error(w, "that path is already registered", http.StatusConflict)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if h.Ingest != nil && h.Ingest.Logger != nil {
		h.Ingest.Logger.Info("music root added", "id", row.ID, "path", row.Path, "label", row.Label)
	}
	if h.Refresh != nil {
		h.Refresh()
	}
	writeJSON(w, http.StatusCreated, rootResp{
		ID:        row.ID.String(),
		Path:      row.Path,
		Label:     row.Label,
		Enabled:   row.Enabled,
		Exists:    true,
		CreatedAt: row.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
	})
}

// Delete removes a music root. By default it also soft-deletes every track
// whose file lived under that root, since the files will no longer be watched
// or scanned. Pass `?purge=false` to keep the DB rows (useful when you plan
// to re-add the root later and don't want to lose play history).
func (h *AdminRoots) Delete(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	purge := true
	if v := r.URL.Query().Get("purge"); v != "" {
		purge = v == "1" || strings.EqualFold(v, "true")
	}

	row, err := h.Store.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, musicroots.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	var deleted int64
	if purge && h.Library != nil {
		prefix := row.Path
		if !strings.HasSuffix(prefix, string(filepath.Separator)) {
			prefix += string(filepath.Separator)
		}
		if n, err := h.Library.SoftDeleteTracksUnderPath(r.Context(), prefix); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		} else {
			deleted = n
		}
	}

	if err := h.Store.Delete(r.Context(), id); err != nil {
		if errors.Is(err, musicroots.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	if h.Ingest != nil && h.Ingest.Logger != nil {
		h.Ingest.Logger.Info("music root removed",
			"id", id, "path", row.Path, "purged_tracks", deleted)
	}
	if h.Refresh != nil {
		h.Refresh()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted_tracks": deleted,
	})
}

type patchRootReq struct {
	Enabled *bool `json:"enabled"`
}

func (h *AdminRoots) Patch(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req patchRootReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Enabled == nil {
		http.Error(w, "nothing to update", http.StatusBadRequest)
		return
	}
	row, err := h.Store.SetEnabled(r.Context(), id, *req.Enabled)
	if err != nil {
		if errors.Is(err, musicroots.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if h.Refresh != nil {
		h.Refresh()
	}
	writeJSON(w, http.StatusOK, rootResp{
		ID:        row.ID.String(),
		Path:      row.Path,
		Label:     row.Label,
		Enabled:   row.Enabled,
		Exists:    dirExists(row.Path),
		CreatedAt: row.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
	})
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
