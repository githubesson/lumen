package handlers

import (
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/pathsafe"
	"github.com/githubesson/lumen/internal/storage"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/trackref"
)

type Tracks struct {
	Library      *library.Store
	Storage      storage.Storage
	Ingest       *ingest.Service
	TIDAL        *tidal.Client
	CoverSignKey []byte
}

// log returns the handler's structured logger, falling back to the slog
// default so call sites never need a nil check.
func (h *Tracks) log() *slog.Logger {
	if h.Ingest != nil && h.Ingest.Logger != nil {
		return h.Ingest.Logger
	}
	return slog.Default()
}

type trackArtistResp struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

type trackDetailResp struct {
	ID            string            `json:"id"`
	DBTrackID     string            `json:"db_track_id,omitempty"`
	Source        string            `json:"source"`
	SourceID      string            `json:"source_id,omitempty"`
	SourceAlbumID string            `json:"source_album_id,omitempty"`
	Title         string            `json:"title"`
	AlbumID       string            `json:"album_id,omitempty"`
	AlbumTitle    string            `json:"album_title,omitempty"`
	TrackNo       int               `json:"track_no,omitempty"`
	DiscNo        int               `json:"disc_no,omitempty"`
	DurationMS    int               `json:"duration_ms"`
	Genre         string            `json:"genre,omitempty"`
	Year          int               `json:"year,omitempty"`
	Composer      string            `json:"composer,omitempty"`
	Comments      string            `json:"comments,omitempty"`
	Format        string            `json:"format"`
	Bitrate       int               `json:"bitrate,omitempty"`
	SampleRate    int               `json:"sample_rate,omitempty"`
	Channels      int               `json:"channels,omitempty"`
	FileSize      int64             `json:"file_size"`
	Artists       []trackArtistResp `json:"artists"`
	Aliases       []trackAliasResp  `json:"aliases,omitempty"`
	HasCover      bool              `json:"has_cover"`
	CoverURL      string            `json:"cover_url,omitempty"`
	Favorited     bool              `json:"favorited"`
}

type trackListItemResp struct {
	ID            string `json:"id"`
	DBTrackID     string `json:"db_track_id,omitempty"`
	Source        string `json:"source,omitempty"`
	SourceID      string `json:"source_id,omitempty"`
	SourceAlbumID string `json:"source_album_id,omitempty"`
	Title         string `json:"title"`
	AlbumID       string `json:"album_id,omitempty"`
	AlbumTitle    string `json:"album_title,omitempty"`
	TrackNo       int    `json:"track_no,omitempty"`
	DurationMS    int    `json:"duration_ms"`
	Artist        string `json:"artist,omitempty"`
	Aka           string `json:"aka,omitempty"` // " • "-joined alt titles from dedup'd copies
	Favorited     bool   `json:"favorited,omitempty"`
	Owned         bool   `json:"owned,omitempty"` // true = the viewer's own personal upload (deletable)
	CoverURL      string `json:"cover_url,omitempty"`
}

type trackAliasResp struct {
	FilePath    string `json:"file_path"`
	Title       string `json:"title,omitempty"`
	ArtistNames string `json:"artist_names,omitempty"`
	AlbumTitle  string `json:"album_title,omitempty"`
}

func makeTrackListItemResp(it library.TrackListItem, favorited, canonical bool) trackListItemResp {
	source := sourceOrLocal(it.Source)
	id := it.ID.String()
	if canonical {
		id = canonicalTrackRef(source, it.ID, it.ExternalID)
	}
	r := trackListItemResp{
		ID:         id,
		DBTrackID:  it.ID.String(),
		Source:     source,
		SourceID:   it.ExternalID,
		Title:      it.Title,
		AlbumTitle: it.AlbumTitle,
		TrackNo:    it.TrackNo,
		DurationMS: it.DurationMS,
		Artist:     it.Artist,
		Aka:        it.Aka,
		Favorited:  favorited,
		Owned:      it.Owned,
		CoverURL:   it.CoverURL,
	}
	if source == trackref.SourceLocal {
		r.SourceID = it.ID.String()
		if !canonical {
			r.DBTrackID = ""
		}
	}
	if it.AlbumID != nil {
		r.AlbumID = it.AlbumID.String()
	}
	return r
}

func (h *Tracks) List(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	limit, offset := pageParams(q)
	query := strings.TrimSpace(q.Get("q"))
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
	total, err := h.Library.CountTracks(r.Context(), u.ID, query)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	favs, _ := h.Library.FavoriteIDs(r.Context(), u.ID)
	out := make([]trackListItemResp, 0, len(items))
	for _, it := range items {
		if _, ok := favs[it.ID]; ok {
			out = append(out, makeTrackListItemResp(it, true, false))
		} else {
			out = append(out, makeTrackListItemResp(it, false, false))
		}
	}
	w.Header().Set("X-Total-Count", strconv.FormatInt(total, 10))
	writeJSON(w, http.StatusOK, out)
}

// Favorite sets the favorite flag on a track for the current user.
func (h *Tracks) Favorite(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, err := resolveTrackRowID(r.Context(), h.Library, h.TIDAL, chi.URLParam(r, "id"), true)
	if err != nil {
		if errors.Is(err, tidal.ErrNotConfigured) {
			http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "bad track id", http.StatusBadRequest)
		return
	}
	if err := h.Library.SetFavorite(r.Context(), u.ID, id, true); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Unfavorite clears the favorite flag.
func (h *Tracks) Unfavorite(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, err := resolveTrackRowID(r.Context(), h.Library, h.TIDAL, chi.URLParam(r, "id"), false)
	if err != nil {
		if errors.Is(err, library.ErrNotFound) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.Error(w, "bad track id", http.StatusBadRequest)
		return
	}
	if err := h.Library.SetFavorite(r.Context(), u.ID, id, false); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListFavorites returns the user's favorited tracks.
func (h *Tracks) ListFavorites(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	limit, offset := pageParams(q)
	items, err := h.Library.ListFavorites(r.Context(), u.ID, limit, offset)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := make([]trackListItemResp, 0, len(items))
	for _, it := range items {
		out = append(out, makeTrackListItemResp(it, true, true))
	}
	writeJSON(w, http.StatusOK, out)
}

// ListRecent returns recently played tracks for the current user.
func (h *Tracks) ListRecent(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	items, err := h.Library.ListRecent(r.Context(), u.ID, limit)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	favs, _ := h.Library.FavoriteIDs(r.Context(), u.ID)
	out := make([]trackListItemResp, 0, len(items))
	for _, it := range items {
		favorited := false
		if _, ok := favs[it.ID]; ok {
			favorited = true
		}
		out = append(out, makeTrackListItemResp(it, favorited, true))
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Tracks) Get(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, err := resolveTrackRowID(r.Context(), h.Library, h.TIDAL, chi.URLParam(r, "id"), true)
	if err != nil {
		if errors.Is(err, tidal.ErrNotConfigured) {
			http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "bad track id", http.StatusBadRequest)
		return
	}
	t, err := h.Library.GetTrack(r.Context(), id, u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	favs, _ := h.Library.FavoriteIDs(r.Context(), u.ID)
	_, isFav := favs[t.ID]
	writeJSON(w, http.StatusOK, makeTrackDetailResp(t, isFav))
}

func makeTrackDetailResp(t *library.TrackDetail, isFav bool) trackDetailResp {
	source := sourceOrLocal(t.Source)
	id := t.ID.String()
	sourceID := t.ExternalID
	if source != trackref.SourceLocal {
		id = canonicalTrackRef(source, t.ID, t.ExternalID)
	} else {
		sourceID = t.ID.String()
	}
	resp := trackDetailResp{
		ID:            id,
		DBTrackID:     t.ID.String(),
		Source:        source,
		SourceID:      sourceID,
		SourceAlbumID: t.ExternalAlbumID,
		Title:         t.Title,
		AlbumTitle:    t.AlbumTitle,
		TrackNo:       t.TrackNo,
		DiscNo:        t.DiscNo,
		DurationMS:    t.DurationMS,
		Genre:         t.Genre,
		Year:          t.Year,
		Composer:      t.Composer,
		Comments:      t.Comments,
		Format:        t.Format,
		Bitrate:       t.Bitrate,
		SampleRate:    t.SampleRate,
		Channels:      t.Channels,
		FileSize:      t.FileSize,
		HasCover:      t.CoverArtPath != "" || t.CoverURL != "",
		CoverURL:      t.CoverURL,
		Favorited:     isFav,
		Artists:       make([]trackArtistResp, 0, len(t.Artists)),
	}
	if t.AlbumID != nil {
		resp.AlbumID = t.AlbumID.String()
	}
	for _, a := range t.Artists {
		resp.Artists = append(resp.Artists, trackArtistResp{
			ID:   a.ID.String(),
			Name: a.Name,
			Role: a.Role,
		})
	}
	for _, al := range t.Aliases {
		resp.Aliases = append(resp.Aliases, trackAliasResp{
			FilePath:    al.FilePath,
			Title:       al.Title,
			ArtistNames: al.ArtistNames,
			AlbumTitle:  al.AlbumTitle,
		})
	}
	return resp
}

type trackPatchReq struct {
	Title       *string   `json:"title,omitempty"`
	Year        *int      `json:"year,omitempty"`
	Genre       *string   `json:"genre,omitempty"`
	DiscNo      *int      `json:"disc_no,omitempty"`
	TrackNo     *int      `json:"track_no,omitempty"`
	Artists     *[]string `json:"artists,omitempty"`      // ordered; first primary, rest featured
	AlbumID     *string   `json:"album_id,omitempty"`     // move into an existing album by id; wins over album_title
	AlbumTitle  *string   `json:"album_title,omitempty"`  // "" to detach
	AlbumArtist *string   `json:"album_artist,omitempty"` // "" means compilation
}

// Patch updates track metadata. Admin only — edits apply to the global row
// (or the admin's personal copy if they own it). The updated track is
// returned in the response so the client can refresh without a second GET.
func (h *Tracks) Patch(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	ref, err := trackref.Parse(chi.URLParam(r, "id"))
	if err != nil || ref.Source != trackref.SourceLocal {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	id := ref.LocalID
	var req trackPatchReq
	if !decodeJSON(w, r, &req) {
		return
	}
	var albumID *uuid.UUID
	if req.AlbumID != nil {
		parsed, perr := uuid.Parse(strings.TrimSpace(*req.AlbumID))
		if perr != nil {
			http.Error(w, "bad album_id", http.StatusBadRequest)
			return
		}
		albumID = &parsed
	}
	err = h.Library.UpdateTrack(r.Context(), id, library.TrackPatch{
		Title:       req.Title,
		Year:        req.Year,
		Genre:       req.Genre,
		DiscNo:      req.DiscNo,
		TrackNo:     req.TrackNo,
		Artists:     req.Artists,
		AlbumID:     albumID,
		AlbumTitle:  req.AlbumTitle,
		AlbumArtist: req.AlbumArtist,
	})
	if err != nil {
		if errors.Is(err, library.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// Fetch the fresh row for the response so the client doesn't have to GET again.
	t, err := h.Library.GetTrack(r.Context(), id, u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	favs, _ := h.Library.FavoriteIDs(r.Context(), u.ID)
	_, isFav := favs[t.ID]
	writeJSON(w, http.StatusOK, makeTrackDetailResp(t, isFav))
}

// Delete removes a track from the caller's personal library. It hard-deletes
// the DB row (cascading to playlist entries, stats, history, artists, and
// aliases) and then deletes the uploaded file from disk. Only the uploader can
// delete their own personal tracks — global tracks and other users' uploads
// are not owned by the caller and return 404.
func (h *Tracks) Delete(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	ref, err := trackref.Parse(chi.URLParam(r, "id"))
	if err != nil || ref.Source != trackref.SourceLocal {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	id := ref.LocalID
	filePath, err := h.Library.DeletePersonalTrack(r.Context(), id, u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	// The row is gone; now delete the uploaded file. Personal uploads always
	// live under MUSIC_ROOT/.users/<user-id>/ — verify the path is inside that
	// directory before unlinking so a malformed row can never remove an
	// arbitrary file. A leftover file is harmless (.users is excluded from the
	// watcher and rescan), so removal failures are logged, not surfaced.
	if filePath != "" {
		userDir := filepath.Join(h.Ingest.MusicRoot, ".users", u.ID.String())
		inUserDir, _ := pathsafe.WithinRoot(userDir, filePath)
		if !inUserDir {
			h.log().Warn("delete: personal track path is outside the user's upload dir; file left in place",
				"path", filePath, "track", id, "user", u.ID)
		} else if rmErr := os.Remove(filePath); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
			h.log().Warn("delete: removing the personal track file failed",
				"path", filePath, "track", id, "user", u.ID, "err", rmErr)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// AdminDelete removes a global track from the shared library. Admin only. It
// hard-deletes the DB row (cascading to playlist entries, stats, history,
// artists, and aliases) and then deletes every on-disk file that fed the track
// — the canonical file plus any deduplicated duplicates — so the watcher and
// rescan don't simply re-ingest it. Personal tracks (owned by a user) are not
// global and return 404; users delete their own uploads via Delete.
//
// Each file is removed only when it sits inside a configured music root and
// outside MUSIC_ROOT/.users/, so a stale row — or a global row that was
// adopted from a personal upload — can never unlink a user's personal file or
// an arbitrary path. A file that can't be removed is logged, not surfaced: the
// DB row is already gone, and a leftover file just gets re-ingested next scan.
func (h *Tracks) AdminDelete(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	ref, err := trackref.Parse(chi.URLParam(r, "id"))
	if err != nil || ref.Source != trackref.SourceLocal {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	id := ref.LocalID
	paths, err := h.Library.DeleteGlobalTrack(r.Context(), id)
	if err != nil {
		if errors.Is(err, library.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		h.log().Error("admin delete: removing the global track row failed",
			"track", id, "user", u.ID, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	roots := h.Ingest.AllRoots(r.Context())
	usersDir := filepath.Join(h.Ingest.MusicRoot, ".users")
	removed := 0
	for _, p := range paths {
		if !pathWithinAnyRoot(roots, p) {
			h.log().Warn("admin delete: track file is outside every configured music root; left in place",
				"path", p, "track", id, "user", u.ID)
			continue
		}
		if pathWithin(usersDir, p) {
			// A global row adopted from a personal upload can still point at a
			// file under .users/. That tree is excluded from the watcher and
			// rescan, so leaving the file is harmless — and removing it would
			// delete someone's personal upload out from under them.
			h.log().Warn("admin delete: track file is a personal upload under .users/; left in place",
				"path", p, "track", id, "user", u.ID)
			continue
		}
		if rmErr := os.Remove(p); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
			h.log().Warn("admin delete: removing the track file failed",
				"path", p, "track", id, "user", u.ID, "err", rmErr)
			continue
		}
		removed++
	}
	h.log().Info("global track removed",
		"track", id, "user", u.ID, "files", len(paths), "files_removed", removed)
	w.WriteHeader(http.StatusNoContent)
}

type playReq struct {
	Completion float32 `json:"completion,omitempty"` // 0.0 - 1.0
}

// RecordPlay bumps play count + history. The client should call this after a
// meaningful listen (e.g. 30s or 50% of duration).
func (h *Tracks) RecordPlay(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	var req playReq
	if r.ContentLength > 0 {
		if !decodeJSON(w, r, &req) {
			return
		}
	}
	if req.Completion < 0 {
		req.Completion = 0
	}
	if req.Completion > 1 {
		req.Completion = 1
	}
	id, err := resolveTrackRowID(r.Context(), h.Library, h.TIDAL, chi.URLParam(r, "id"), true)
	if err != nil {
		if errors.Is(err, tidal.ErrNotConfigured) {
			http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "bad track id", http.StatusBadRequest)
		return
	}
	if err := h.Library.RecordPlay(r.Context(), u.ID, id, req.Completion); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// pathWithin reports whether p lies inside dir (or equals it). Used to keep
// file removals scoped — e.g. so admin track deletion never unlinks anything
// under MUSIC_ROOT/.users/.
func pathWithin(dir, p string) bool {
	ok, err := pathsafe.WithinRoot(dir, p)
	return err == nil && ok
}
