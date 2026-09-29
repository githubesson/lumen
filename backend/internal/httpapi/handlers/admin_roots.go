package handlers

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/dbutil"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/githubesson/lumen/internal/pathsafe"
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

	usage musicroots.UsageCache
}

type rootResp struct {
	ID      string `json:"id"`
	Path    string `json:"path"`
	Label   string `json:"label"`
	Enabled bool   `json:"enabled"`
	Primary bool   `json:"primary"`
	Exists  bool   `json:"exists"`
	// CoveredBy is another watched root that contains this one, if any.
	// Removing a covered root leaves its files scanned and streamable.
	CoveredBy string `json:"covered_by,omitempty"`
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
	watched := []string{h.PrimaryRoot}
	for _, r := range rows {
		if r.Enabled {
			watched = append(watched, r.Path)
		}
	}
	for _, r := range rows {
		out = append(out, rootResp{
			ID:        r.ID.String(),
			Path:      r.Path,
			Label:     r.Label,
			Enabled:   r.Enabled,
			Exists:    dirExists(r.Path),
			CoveredBy: coveringRoot(r.Path, watched),
			CreatedAt: r.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

type rootsUsageResp struct {
	Roots      []musicroots.Usage `json:"roots"`
	MeasuredAt string             `json:"measured_at"`
}

// Usage reports how many files each root holds and how much space they take,
// paused roots included. It's a separate call from List because it walks the
// disk: the first request (and one with ?refresh=1, sent after a rescan) can
// take a while on a big library, and the root pickers elsewhere on the page
// shouldn't wait for it.
func (h *AdminRoots) Usage(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Store.List(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	paths := make([]string, 0, len(rows)+1)
	paths = append(paths, h.PrimaryRoot)
	for _, row := range rows {
		paths = append(paths, row.Path)
	}
	fresh := r.URL.Query().Get("refresh") == "1"
	usage, at, err := h.usage.Get(r.Context(), paths, fresh)
	if err != nil {
		if r.Context().Err() == nil {
			http.Error(w, "measuring folders timed out", http.StatusGatewayTimeout)
		}
		return
	}
	writeJSON(w, http.StatusOK, rootsUsageResp{
		Roots:      usage,
		MeasuredAt: at.UTC().Format("2006-01-02T15:04:05Z"),
	})
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
		// Only purge what stops being watched. Tracks under another live root
		// stay: that root still scans them, and a purge would only bring them
		// back as new rows without their history or playlist places.
		live, err := h.liveRootsExcept(r, row.ID)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if coveringRoot(row.Path, live) == "" {
			var keep []string
			for _, other := range live {
				if inside, _ := pathsafe.WithinRoot(row.Path, other); inside {
					keep = append(keep, withSeparator(other))
				}
			}
			n, err := h.Library.SoftDeleteTracksUnderPath(r.Context(), withSeparator(row.Path), keep)
			if err != nil {
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
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

// liveRootsExcept returns the roots that are scanned (the primary and every
// enabled extra root), leaving out the one with id skip.
func (h *AdminRoots) liveRootsExcept(r *http.Request, skip uuid.UUID) ([]string, error) {
	rows, err := h.Store.List(r.Context())
	if err != nil {
		return nil, err
	}
	live := []string{h.PrimaryRoot}
	for _, row := range rows {
		if row.Enabled && row.ID != skip {
			live = append(live, row.Path)
		}
	}
	return live, nil
}

// withSeparator ends a directory path with the separator, so as a prefix it
// matches what's inside it and not siblings sharing its name (/music-archive).
func withSeparator(dir string) string {
	if strings.HasSuffix(dir, string(filepath.Separator)) {
		return dir
	}
	return dir + string(filepath.Separator)
}

// coveringRoot returns a watched root, other than path itself, whose scan
// reaches path, or "" if there's none. The scan skips dot-directories and
// doesn't follow symlinks, so a folder past either isn't covered even when
// its path is inside another root.
func coveringRoot(path string, watched []string) string {
	for _, w := range watched {
		if same, _ := pathsafe.WithinRoot(path, w); same {
			continue
		}
		if musicroots.Reaches(w, path, true) {
			return w
		}
	}
	return ""
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
