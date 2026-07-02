package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/library"
)

// Browse serves server-aggregated lists of albums and artists. This replaces
// client-side grouping over the tracks list, which couldn't see past the
// current pagination window.
type Browse struct {
	Library *library.Store
}

type albumListResp struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	ArtistID      string `json:"artist_id,omitempty"`
	ArtistName    string `json:"artist_name,omitempty"`
	IsCompilation bool   `json:"is_compilation"`
	ReleaseYear   int    `json:"release_year,omitempty"`
	TrackCount    int    `json:"track_count"`
	DurationMS    int64  `json:"duration_ms"`
	HasCover      bool   `json:"has_cover"`
}

type artistListResp struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	TrackCount int    `json:"track_count"`
	AlbumCount int    `json:"album_count"`
}

func (h *Browse) ListAlbums(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	limit, offset := pageParams(q)
	query := strings.TrimSpace(q.Get("q"))

	items, err := h.Library.ListAlbums(r.Context(), u.ID, limit, offset, query)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	total, err := h.Library.CountAlbums(r.Context(), u.ID, query)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := make([]albumListResp, 0, len(items))
	for _, a := range items {
		row := albumListResp{
			ID:            a.ID.String(),
			Title:         a.Title,
			ArtistName:    a.ArtistName,
			IsCompilation: a.IsCompilation,
			ReleaseYear:   a.ReleaseYear,
			TrackCount:    a.TrackCount,
			DurationMS:    a.DurationMS,
			HasCover:      a.HasCover,
		}
		if a.ArtistID != nil {
			row.ArtistID = a.ArtistID.String()
		}
		out = append(out, row)
	}
	w.Header().Set("X-Total-Count", strconv.FormatInt(total, 10))
	writeJSON(w, http.StatusOK, out)
}

// makeAlbumResp shapes an AlbumDetail into the wire response used by every
// endpoint that returns a single album (get / patch / cover change).
func makeAlbumResp(a *library.AlbumDetail) albumListResp {
	row := albumListResp{
		ID:            a.ID.String(),
		Title:         a.Title,
		ArtistName:    a.ArtistName,
		IsCompilation: a.IsCompilation,
		ReleaseYear:   a.ReleaseYear,
		TrackCount:    a.TrackCount,
		DurationMS:    a.DurationMS,
		HasCover:      a.HasCover,
	}
	if a.ArtistID != nil {
		row.ArtistID = a.ArtistID.String()
	}
	return row
}

func (h *Browse) GetAlbum(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	a, err := h.Library.GetAlbum(r.Context(), id, u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, makeAlbumResp(a))
}

func (h *Browse) ListAlbumTracks(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	items, err := h.Library.ListAlbumTracks(r.Context(), id, u.ID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	favs, _ := h.Library.FavoriteIDs(r.Context(), u.ID)
	writeJSON(w, http.StatusOK, trackListItems(items, favs))
}

type albumPatchReq struct {
	Title         *string `json:"title,omitempty"`
	AlbumArtist   *string `json:"album_artist,omitempty"` // "" = compilation (null album_artist_id)
	ReleaseYear   *int    `json:"release_year,omitempty"`
	IsCompilation *bool   `json:"is_compilation,omitempty"`
}

// PatchAlbum updates album metadata. Admin only.
func (h *Browse) PatchAlbum(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req albumPatchReq
	if !decodeJSON(w, r, &req) {
		return
	}
	err := h.Library.UpdateAlbum(r.Context(), id, library.AlbumPatch{
		Title:         req.Title,
		AlbumArtist:   req.AlbumArtist,
		ReleaseYear:   req.ReleaseYear,
		IsCompilation: req.IsCompilation,
	})
	if err != nil {
		if errors.Is(err, library.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	a, err := h.Library.GetAlbum(r.Context(), id, u.ID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, makeAlbumResp(a))
}

func (h *Browse) ListArtists(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	limit, offset := pageParams(q)
	query := strings.TrimSpace(q.Get("q"))

	items, err := h.Library.ListArtists(r.Context(), u.ID, limit, offset, query)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	total, err := h.Library.CountArtists(r.Context(), u.ID, query)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := make([]artistListResp, 0, len(items))
	for _, a := range items {
		out = append(out, artistListResp{
			ID:         a.ID.String(),
			Name:       a.Name,
			TrackCount: a.TrackCount,
			AlbumCount: a.AlbumCount,
		})
	}
	w.Header().Set("X-Total-Count", strconv.FormatInt(total, 10))
	writeJSON(w, http.StatusOK, out)
}

func (h *Browse) GetArtist(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	a, err := h.Library.GetArtist(r.Context(), id, u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, artistListResp{
		ID:         a.ID.String(),
		Name:       a.Name,
		TrackCount: a.TrackCount,
		AlbumCount: a.AlbumCount,
	})
}

func (h *Browse) ListArtistTracks(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	items, err := h.Library.ListArtistTracks(r.Context(), id, u.ID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	favs, _ := h.Library.FavoriteIDs(r.Context(), u.ID)
	writeJSON(w, http.StatusOK, trackListItems(items, favs))
}

// trackListItems is the shared shape-shifter used by every endpoint that
// returns a row of tracks — mirrors trackListItemResp in tracks.go but lives
// here so browse handlers don't reach across files.
func trackListItems(items []library.TrackListItem, favs map[uuid.UUID]struct{}) []trackListItemResp {
	out := make([]trackListItemResp, 0, len(items))
	for _, it := range items {
		_, favorited := favs[it.ID]
		out = append(out, makeTrackListItemResp(it, favorited, false))
	}
	return out
}
