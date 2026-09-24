package handlers

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/mediaembed"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/tidaldl"
)

// AdminTIDALDownloads configures and reports on TIDAL playlist auto-download.
type AdminTIDALDownloads struct {
	Store       *tidaldl.Store
	Worker      *tidaldl.Worker
	MusicRoots  *musicroots.Store
	PrimaryRoot string
	// For album downloads.
	TIDAL   *tidal.Client
	Library *library.Store
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

type albumDownloadResp struct {
	Queued      int `json:"queued"`      // newly queued tracks
	Saved       int `json:"saved"`       // already in the library
	Unavailable int `json:"unavailable"` // no longer on TIDAL and not in the library
}

// DownloadAlbum queues every track of a TIDAL release the library has no copy
// of, whether or not any were saved before. It queues exactly the rows the
// album view shows as TIDAL tracks.
func (h *AdminTIDALDownloads) DownloadAlbum(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	if h.Store == nil || h.Library == nil {
		http.Error(w, "auto-download not configured", http.StatusServiceUnavailable)
		return
	}
	release, err := h.fullRelease(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, tidal.ErrNotConfigured) {
			http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "tidal album unavailable", http.StatusBadGateway)
		return
	}
	var localAlbum *uuid.UUID
	if id, err := h.Library.LocalAlbumForTIDAL(r.Context(), release.ID, u.ID); err == nil {
		localAlbum = &id
	}
	view, err := mergeWithLibrary(r.Context(), h.Library, release, localAlbum, u.ID, false)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	byID := make(map[string]tidal.Track, len(release.Tracks))
	for _, t := range release.Tracks {
		byID[t.ID] = t
	}
	out := albumDownloadResp{Saved: view.SavedCount}
	var ids []string
	for _, row := range view.Tracks {
		t, remote := byID[row.SourceID]
		if row.Source != "tidal" || !remote {
			continue
		}
		if row.Unavailable {
			out.Unavailable++
			continue
		}
		// The worker works from remote track rows; make sure each exists.
		if _, err := h.Library.UpsertRemoteTrack(r.Context(), library.RemoteTrackInput{
			Source: "tidal", ExternalID: t.ID, Title: t.Title, ArtistNames: t.Artists,
			AlbumTitle: firstNonEmpty(t.AlbumTitle, release.Title), AlbumArtist: firstNonEmpty(t.AlbumArtist, release.Artist),
			DurationMS: t.DurationMS, TrackNo: t.TrackNo, DiscNo: t.DiscNo, Year: release.ReleaseYear,
			ISRC: t.ISRC, CoverID: firstNonEmpty(t.CoverID, release.CoverID),
			CoverURL: firstNonEmpty(t.CoverURL, release.CoverURL), Metadata: t.Metadata(),
		}); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		ids = append(ids, t.ID)
	}
	if out.Queued, err = h.Store.RequestTracks(r.Context(), release.ID, ids, u.ID); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	h.Worker.Kick()
	writeJSON(w, http.StatusOK, out)
}

// CancelAlbumDownload drops a release's queued tracks; saved ones stay.
func (h *AdminTIDALDownloads) CancelAlbumDownload(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		http.Error(w, "auto-download not configured", http.StatusServiceUnavailable)
		return
	}
	n, err := h.Store.CancelAlbumRequests(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"cancelled": n})
}

// fullRelease fetches a release in full and folds it into the stored record,
// returning the record (which also lists tracks TIDAL has dropped). Without
// TIDAL it falls back to the stored record.
func (h *AdminTIDALDownloads) fullRelease(ctx context.Context, id string) (tidal.Album, error) {
	err := tidal.ErrNotConfigured
	if h.TIDAL != nil {
		var fresh tidal.Album
		if fresh, err = h.TIDAL.FullAlbum(ctx, id); err == nil {
			if serr := h.Library.SaveTIDALAlbum(ctx, fresh); serr != nil {
				slog.Warn("tidal album cache write failed", "album", id, "err", serr)
				return fresh, nil
			}
		}
	}
	stored, _, cerr := h.Library.TIDALAlbum(ctx, id)
	if cerr == nil {
		return stored, nil
	}
	if err != nil {
		return tidal.Album{}, err
	}
	return tidal.Album{}, cerr
}
