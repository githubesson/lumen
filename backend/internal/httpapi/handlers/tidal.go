package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/trackref"
)

type TIDAL struct {
	TIDAL *tidal.Client
}

type tidalAlbumResp struct {
	ID          string              `json:"id"`
	Title       string              `json:"title"`
	Artist      string              `json:"artist,omitempty"`
	ReleaseYear int                 `json:"release_year,omitempty"`
	TrackCount  int                 `json:"track_count"`
	DurationMS  int                 `json:"duration_ms"`
	CoverURL    string              `json:"cover_url,omitempty"`
	Tracks      []trackListItemResp `json:"tracks"`
}

func (h *TIDAL) Album(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUser(w, r); !ok {
		return
	}
	if h.TIDAL == nil {
		http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	album, err := h.TIDAL.Album(r.Context(), chi.URLParam(r, "id"), limit, offset)
	if err != nil {
		if errors.Is(err, tidal.ErrNotConfigured) {
			http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "tidal album unavailable", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, makeTIDALAlbumResp(album))
}

func makeTIDALAlbumResp(album tidal.Album) tidalAlbumResp {
	out := tidalAlbumResp{
		ID:          album.ID,
		Title:       album.Title,
		Artist:      album.Artist,
		ReleaseYear: album.ReleaseYear,
		TrackCount:  album.TrackCount,
		DurationMS:  album.DurationMS,
		CoverURL:    album.CoverURL,
		Tracks:      make([]trackListItemResp, 0, len(album.Tracks)),
	}
	for _, it := range album.Tracks {
		out.Tracks = append(out.Tracks, trackListItemResp{
			ID:            trackref.Remote(trackref.SourceTIDAL, it.ID),
			Source:        trackref.SourceTIDAL,
			SourceID:      it.ID,
			SourceAlbumID: it.AlbumID,
			Title:         it.Title,
			AlbumTitle:    firstNonEmpty(it.AlbumTitle, album.Title),
			TrackNo:       it.TrackNo,
			DurationMS:    it.DurationMS,
			Artist:        strings.Join(it.Artists, ", "),
			CoverURL:      firstNonEmpty(it.CoverURL, album.CoverURL),
		})
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
