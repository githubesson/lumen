package handlers

import (
	"net/http"
	"strings"

	"github.com/githubesson/lumen/internal/mediaembed"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/githubesson/lumen/internal/tidaldl"
)

// AdminTIDALDownloads configures and reports on TIDAL playlist auto-download.
type AdminTIDALDownloads struct {
	Store       *tidaldl.Store
	Worker      *tidaldl.Worker
	MusicRoots  *musicroots.Store
	PrimaryRoot string
}

type tidalAutoDownloadResp struct {
	RootID string `json:"root_id,omitempty"`
	Subdir string `json:"subdir"`
	// Destination is the resolved absolute directory; DestinationError is set
	// instead when it cannot be resolved (e.g. the chosen root was deleted).
	Destination      string             `json:"destination,omitempty"`
	DestinationError string             `json:"destination_error,omitempty"`
	FFmpeg           bool               `json:"ffmpeg"`
	Summary          tidaldl.Summary    `json:"summary"`
	Recent           []tidaldl.Download `json:"recent"`
}

func (h *AdminTIDALDownloads) Status(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.Store == nil {
		http.Error(w, "auto-download not configured", http.StatusServiceUnavailable)
		return
	}
	settings, err := h.Store.Settings(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	summary, err := h.Store.Summary(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	recent, err := h.Store.Recent(r.Context(), 50)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := tidalAutoDownloadResp{
		Subdir:  settings.Subdir,
		FFmpeg:  mediaembed.Available(),
		Summary: summary,
		Recent:  recent,
	}
	if settings.RootID != nil {
		out.RootID = settings.RootID.String()
	}
	if h.Worker != nil {
		if dest, err := h.Worker.Destination(r.Context()); err != nil {
			out.DestinationError = err.Error()
		} else {
			out.Destination = dest
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type tidalAutoDownloadSettingsReq struct {
	RootID string `json:"root_id"` // blank = primary music root
	Subdir string `json:"subdir"`
}

func (h *AdminTIDALDownloads) SaveSettings(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		http.Error(w, "auto-download not configured", http.StatusServiceUnavailable)
		return
	}
	var req tidalAutoDownloadSettingsReq
	if !decodeJSON(w, r, &req) {
		return
	}
	rootID, rootPath, err := resolvePinRoot(r, h.MusicRoots, h.PrimaryRoot, req.RootID, "")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// Files under a disabled root cannot be streamed.
	if rootID != nil {
		root, err := h.MusicRoots.Get(r.Context(), *rootID)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if !root.Enabled {
			http.Error(w, "root is disabled", http.StatusBadRequest)
			return
		}
	}
	subdir, err := cleanPinSubdir(rootPath, req.Subdir)
	if err != nil {
		http.Error(w, strings.Replace(err.Error(), "destination_subdir", "subdir", 1), http.StatusBadRequest)
		return
	}
	if err := h.Store.SaveSettings(r.Context(), tidaldl.Settings{RootID: rootID, Subdir: subdir}); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	h.Status(w, r)
}

// Retry makes every failed download due now and wakes the worker.
func (h *AdminTIDALDownloads) Retry(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		http.Error(w, "auto-download not configured", http.StatusServiceUnavailable)
		return
	}
	n, err := h.Store.RetryFailed(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	h.Worker.Kick()
	writeJSON(w, http.StatusOK, map[string]int64{"retried": n})
}
