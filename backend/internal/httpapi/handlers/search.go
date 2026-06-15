package handlers

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/trackref"
)

type Search struct {
	Library *library.Store
	TIDAL   *tidal.Client
}

type searchResp struct {
	Tracks   []trackListItemResp `json:"tracks"`
	Sources  []string            `json:"sources"`
	Warnings []string            `json:"warnings,omitempty"`
}

func (h *Search) Search(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	query := strings.TrimSpace(q.Get("q"))
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))
	if limit <= 0 || limit > 50 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}
	sources := parseSources(q.Get("sources"))
	favs, _ := h.Library.FavoriteIDs(r.Context(), u.ID)

	resp := searchResp{Sources: sources}
	if hasSource(sources, trackref.SourceLocal) {
		items, err := h.Library.ListTracks(r.Context(), library.ListTracksParams{
			ViewerID: u.ID,
			Limit:    limit,
			Offset:   offset,
			Query:    query,
		})
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		for _, it := range items {
			_, favorited := favs[it.ID]
			resp.Tracks = append(resp.Tracks, makeTrackListItemResp(it, favorited, true))
		}
	}
	if hasSource(sources, trackref.SourceTIDAL) && query != "" {
		if h.TIDAL == nil {
			resp.Warnings = append(resp.Warnings, "tidal proxy is not configured")
		} else {
			items, err := h.TIDAL.SearchTracks(r.Context(), query, limit, offset)
			if err != nil {
				if errors.Is(err, tidal.ErrNotConfigured) {
					resp.Warnings = append(resp.Warnings, "tidal proxy is not configured")
				} else {
					slog.Warn("tidal search failed", "err", err)
					resp.Warnings = append(resp.Warnings, fmt.Sprintf("tidal search failed: %s", err))
				}
			}
			for _, it := range items {
				resp.Tracks = append(resp.Tracks, trackListItemResp{
					ID:            trackref.Remote(trackref.SourceTIDAL, it.ID),
					Source:        trackref.SourceTIDAL,
					SourceID:      it.ID,
					SourceAlbumID: it.AlbumID,
					Title:         it.Title,
					AlbumTitle:    it.AlbumTitle,
					TrackNo:       it.TrackNo,
					DurationMS:    it.DurationMS,
					Artist:        strings.Join(it.Artists, ", "),
					CoverURL:      it.CoverURL,
				})
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func parseSources(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return []string{trackref.SourceLocal, trackref.SourceTIDAL}
	}
	seen := map[string]struct{}{}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		source := strings.ToLower(strings.TrimSpace(part))
		if source != trackref.SourceLocal && source != trackref.SourceTIDAL {
			continue
		}
		if _, ok := seen[source]; ok {
			continue
		}
		seen[source] = struct{}{}
		out = append(out, source)
	}
	if len(out) == 0 {
		return []string{trackref.SourceLocal, trackref.SourceTIDAL}
	}
	return out
}

func hasSource(sources []string, source string) bool {
	for _, s := range sources {
		if s == source {
			return true
		}
	}
	return false
}
