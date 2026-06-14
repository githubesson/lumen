package handlers

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpx"
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

const maxServedCoverDimension = 1024

// maxCoverUploadBytes caps an admin's cover-art upload. Cover art is small;
// 16 MiB is comfortably above any real album scan while still bounding memory.
const maxCoverUploadBytes int64 = 16 << 20

const maxRemoteCoverBytes int64 = 16 << 20

var remoteCoverHTTPClient = &http.Client{
	Timeout: 10 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		_, err := allowedRemoteCoverURL(req.URL.String())
		return err
	},
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
	ID         string            `json:"id"`
	DBTrackID  string            `json:"db_track_id,omitempty"`
	Source     string            `json:"source"`
	SourceID   string            `json:"source_id,omitempty"`
	Title      string            `json:"title"`
	AlbumID    string            `json:"album_id,omitempty"`
	AlbumTitle string            `json:"album_title,omitempty"`
	TrackNo    int               `json:"track_no,omitempty"`
	DiscNo     int               `json:"disc_no,omitempty"`
	DurationMS int               `json:"duration_ms"`
	Genre      string            `json:"genre,omitempty"`
	Year       int               `json:"year,omitempty"`
	Composer   string            `json:"composer,omitempty"`
	Comments   string            `json:"comments,omitempty"`
	Format     string            `json:"format"`
	Bitrate    int               `json:"bitrate,omitempty"`
	SampleRate int               `json:"sample_rate,omitempty"`
	Channels   int               `json:"channels,omitempty"`
	FileSize   int64             `json:"file_size"`
	Artists    []trackArtistResp `json:"artists"`
	Aliases    []trackAliasResp  `json:"aliases,omitempty"`
	HasCover   bool              `json:"has_cover"`
	CoverURL   string            `json:"cover_url,omitempty"`
	Favorited  bool              `json:"favorited"`
}

type trackListItemResp struct {
	ID         string `json:"id"`
	DBTrackID  string `json:"db_track_id,omitempty"`
	Source     string `json:"source,omitempty"`
	SourceID   string `json:"source_id,omitempty"`
	Title      string `json:"title"`
	AlbumID    string `json:"album_id,omitempty"`
	AlbumTitle string `json:"album_title,omitempty"`
	TrackNo    int    `json:"track_no,omitempty"`
	DurationMS int    `json:"duration_ms"`
	Artist     string `json:"artist,omitempty"`
	Aka        string `json:"aka,omitempty"` // " • "-joined alt titles from dedup'd copies
	Favorited  bool   `json:"favorited,omitempty"`
	Owned      bool   `json:"owned,omitempty"` // true = the viewer's own personal upload (deletable)
	CoverURL   string `json:"cover_url,omitempty"`
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
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))
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
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))
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
		ID:         id,
		DBTrackID:  t.ID.String(),
		Source:     source,
		SourceID:   sourceID,
		Title:      t.Title,
		AlbumTitle: t.AlbumTitle,
		TrackNo:    t.TrackNo,
		DiscNo:     t.DiscNo,
		DurationMS: t.DurationMS,
		Genre:      t.Genre,
		Year:       t.Year,
		Composer:   t.Composer,
		Comments:   t.Comments,
		Format:     t.Format,
		Bitrate:    t.Bitrate,
		SampleRate: t.SampleRate,
		Channels:   t.Channels,
		FileSize:   t.FileSize,
		HasCover:   t.CoverArtPath != "" || t.CoverURL != "",
		CoverURL:   t.CoverURL,
		Favorited:  isFav,
		Artists:    make([]trackArtistResp, 0, len(t.Artists)),
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

// Stream serves the raw audio file with HTTP range support via
// http.ServeContent. Authentication is enforced by the middleware chain
// (session cookie), same as every other /api route.
func (h *Tracks) Stream(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	ref, err := trackref.Parse(chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if ref.Source == trackref.SourceTIDAL {
		h.streamTIDAL(w, r, ref.ID)
		return
	}
	id := ref.LocalID
	if id == uuid.Nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	t, err := h.Library.GetTrack(r.Context(), id, u.ID)
	if err != nil {
		if errors.Is(err, library.ErrNotFound) {
			h.log().Warn("stream: track not found or not visible to this user",
				"track", id, "user", u.ID)
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		h.log().Error("stream: track lookup failed", "track", id, "user", u.ID, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	roots := h.Ingest.AllRoots(r.Context())
	if !pathWithinAnyRoot(roots, t.FilePath) {
		// The file_path in the DB sits outside every configured music root.
		// Almost always a stale path: the track was ingested under an old
		// MUSIC_PATH (or a now-removed root) that no longer matches.
		h.log().Warn("stream: track file path is outside every configured music root — stale file_path, likely predates a MUSIC_PATH/root change",
			"track", id, "user", u.ID, "path", t.FilePath, "roots", roots)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	f, err := os.Open(t.FilePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			h.log().Warn("stream: track file is missing on disk",
				"track", id, "user", u.ID, "path", t.FilePath)
			http.Error(w, "file missing on disk", http.StatusGone)
			return
		}
		h.log().Error("stream: could not open track file — check filesystem permissions on the music volume",
			"track", id, "user", u.ID, "path", t.FilePath, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		h.log().Error("stream: could not stat track file",
			"track", id, "user", u.ID, "path", t.FilePath, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", audioContentType(t.Format, t.FilePath))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "private, max-age=0")
	http.ServeContent(w, r, filepath.Base(t.FilePath), stat.ModTime(), f)
}

func (h *Tracks) streamTIDAL(w http.ResponseWriter, r *http.Request, tidalID string) {
	if h.TIDAL == nil {
		h.log().Warn("stream: tidal client not configured", "tidal_track", tidalID)
		http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
		return
	}
	resp, err := h.TIDAL.HLSResponse(r.Context(), tidalID, r, func(rawURL string) string {
		return tidalHLSProxyURL(tidalID, rawURL)
	})
	if err != nil {
		if errors.Is(err, tidal.ErrNotConfigured) {
			h.log().Warn("stream: tidal proxy not configured", "tidal_track", tidalID, "err", err)
			http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
			return
		}
		if errors.Is(err, tidal.ErrDASHManifest) {
			h.log().Warn("stream: tidal dash manifest unsupported", "tidal_track", tidalID, "err", err)
			http.Error(w, "tidal stream format is not supported yet", http.StatusBadGateway)
			return
		}
		if errors.Is(err, tidal.ErrPreviewManifest) {
			h.log().Warn("stream: tidal preview manifest rejected", "tidal_track", tidalID, "err", err)
			http.Error(w, tidalStreamErrorMessage(err), http.StatusBadGateway)
			return
		}
		h.log().Warn("stream: tidal proxy failed", "tidal_track", tidalID, "err", err)
		http.Error(w, tidalStreamErrorMessage(err), http.StatusBadGateway)
		return
	}
	h.log().Info("stream: tidal track started playing",
		"tidal_track", tidalID,
		"status", resp.StatusCode,
		"content_type", resp.Header.Get("Content-Type"))
	writeTIDALProxyResponse(w, resp)
}

func (h *Tracks) TIDALHLS(w http.ResponseWriter, r *http.Request) {
	ref, err := trackref.Parse(chi.URLParam(r, "id"))
	if err != nil || ref.Source != trackref.SourceTIDAL {
		h.log().Warn("stream: tidal hls bad id", "raw_id", chi.URLParam(r, "id"), "err", err)
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	h.log().Debug("stream: tidal hls request start",
		"tidal_track", ref.ID,
		"path", r.URL.Path,
		"range", r.Header.Get("Range"),
		"user_agent", r.UserAgent())
	if h.TIDAL == nil {
		h.log().Warn("stream: tidal hls client not configured", "tidal_track", ref.ID)
		http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
		return
	}
	rawURL, err := decodeTIDALHLSURL(r.URL.Query().Get("u"))
	if err != nil {
		h.log().Warn("stream: tidal hls bad proxied url", "tidal_track", ref.ID, "err", err)
		http.Error(w, "bad hls url", http.StatusBadRequest)
		return
	}
	resp, err := h.TIDAL.HLSProxyResponse(r.Context(), rawURL, r, func(nextURL string) string {
		return tidalHLSProxyURL(ref.ID, nextURL)
	})
	if err != nil {
		h.log().Warn("stream: tidal hls proxy failed", "tidal_track", ref.ID, "err", err)
		http.Error(w, tidalStreamErrorMessage(err), http.StatusBadGateway)
		return
	}
	h.log().Debug("stream: tidal hls response ready",
		"tidal_track", ref.ID,
		"status", resp.StatusCode,
		"content_type", resp.Header.Get("Content-Type"),
		"content_length", resp.ContentLength)
	writeTIDALProxyResponse(w, resp)
}

func writeTIDALProxyResponse(w http.ResponseWriter, resp *http.Response) {
	defer resp.Body.Close()
	for _, name := range []string{
		"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges",
		"ETag", "Last-Modified",
	} {
		if v := resp.Header.Get(name); v != "" {
			w.Header().Set(name, v)
		}
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "audio/mp4")
	}
	w.Header().Set("Cache-Control", "private, max-age=0")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func tidalHLSProxyURL(tidalID, rawURL string) string {
	q := url.Values{}
	q.Set("u", base64.RawURLEncoding.EncodeToString([]byte(rawURL)))
	return "/api/tracks/" + url.PathEscape(trackref.SourceTIDAL+":"+tidalID) + "/hls?" + q.Encode()
}

func decodeTIDALHLSURL(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", errors.New("missing hls url")
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func tidalStreamErrorMessage(err error) string {
	msg := strings.TrimSpace(err.Error())
	if msg == "" {
		return "tidal stream unavailable"
	}
	return "tidal stream unavailable: " + redactTIDALStreamError(msg)
}

func redactTIDALStreamError(msg string) string {
	msg = streamURLRe.ReplaceAllString(msg, "[url]")
	msg = streamTokenRe.ReplaceAllString(msg, "${1}[redacted]")
	return msg
}

var (
	streamURLRe   = regexp.MustCompile(`https?://[^\s"']+`)
	streamTokenRe = regexp.MustCompile(`(?i)(token=)[^&\s"']+`)
)

// TrackCover serves the cover art associated with a single track's album.
func (h *Tracks) TrackCover(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, err := resolveTrackRowID(r.Context(), h.Library, h.TIDAL, chi.URLParam(r, "id"), false)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	t, err := h.Library.GetTrack(r.Context(), id, u.ID)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	maxSize := parseCoverMaxSize(r)
	if t.CoverArtPath != "" {
		h.serveStorageObject(w, r, t.CoverArtPath, maxSize)
		return
	}
	if t.CoverURL != "" {
		h.serveRemoteCover(w, r, t.CoverURL)
		return
	}
	http.Error(w, "no cover", http.StatusNotFound)
}

// AlbumCover serves the cover for an album directly.
func (h *Tracks) AlbumCover(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	maxSize := parseCoverMaxSize(r)
	if key, err := h.Library.AlbumCoverPathForViewer(r.Context(), id, u.ID); err == nil {
		h.serveStorageObject(w, r, key, maxSize)
		return
	} else if !errors.Is(err, library.ErrNotFound) {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	cover, err := h.Library.RemoteAlbumCoverForViewer(r.Context(), id, u.ID)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	h.serveRemoteCover(w, r, remoteCoverURLForSize(cover, maxSize))
}

// PutAlbumCover replaces an album's cover art with an uploaded image. Admin
// only. Accepts a multipart form with a single `file` part; the image is
// normalized (decoded, resized, re-encoded as JPEG) and stored content-
// addressed, then the album row is pointed at the new key. Returns the updated
// album so the client can refresh without a second request.
func (h *Tracks) PutAlbumCover(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxCoverUploadBytes)
	if err := r.ParseMultipartForm(maxCoverUploadBytes); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			http.Error(w, "image too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "no image file", http.StatusBadRequest)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "could not read upload", http.StatusBadRequest)
		return
	}
	// Decode once up front to reject anything that isn't a real, supported
	// image before it ever reaches storage.
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		http.Error(w, "file is not a supported image (jpeg, png, webp)", http.StatusBadRequest)
		return
	}
	key, err := h.Ingest.StoreCoverImage(r.Context(), data, header.Header.Get("Content-Type"))
	if err != nil || key == "" {
		h.log().Error("album cover: storing the uploaded image failed",
			"album", id, "user", u.ID, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := h.Library.SetAlbumCover(r.Context(), id, key); err != nil {
		if errors.Is(err, library.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		h.log().Error("album cover: pointing the album at the new key failed",
			"album", id, "user", u.ID, "key", key, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	h.log().Info("album cover replaced", "album", id, "user", u.ID, "key", key)
	a, err := h.Library.GetAlbum(r.Context(), id, u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, makeAlbumResp(a))
}

// DeleteAlbumCover clears an album's cover art, reverting it to the
// hash-tinted placeholder. Admin only. The content-addressed blob is left in
// storage since other albums may reference it. Returns the updated album.
func (h *Tracks) DeleteAlbumCover(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	if err := h.Library.ClearAlbumCover(r.Context(), id); err != nil {
		if errors.Is(err, library.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		h.log().Error("album cover: clearing the cover reference failed",
			"album", id, "user", u.ID, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	h.log().Info("album cover removed", "album", id, "user", u.ID)
	a, err := h.Library.GetAlbum(r.Context(), id, u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, makeAlbumResp(a))
}

type signCoverResp struct {
	URL       string `json:"url"`
	ExpiresAt int64  `json:"expires_at"`
}

// SignCover issues a short-lived signed URL that serves an album cover
// without session auth. The renderer calls this before pushing Discord
// Rich Presence so Discord's media proxy (cookie-less) can fetch artwork.
func (h *Tracks) SignCover(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	if len(h.CoverSignKey) == 0 {
		http.Error(w, "signing not configured", http.StatusServiceUnavailable)
		return
	}
	raw := strings.TrimSpace(r.URL.Query().Get("album_id"))
	if raw == "" {
		http.Error(w, "album_id required", http.StatusBadRequest)
		return
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		http.Error(w, "bad album_id", http.StatusBadRequest)
		return
	}
	// Refuse to mint URLs for albums with no cover, so clients don't ship
	// a URL that will resolve to 404 on Discord (which then caches the
	// failure).
	if _, err := h.Library.AlbumCoverPathForViewer(r.Context(), id, u.ID); err != nil {
		http.Error(w, "no cover", http.StatusNotFound)
		return
	}
	exp, sig := auth.SignCoverURL(h.CoverSignKey, "album", id.String(), time.Now())
	resp := signCoverResp{
		URL:       "/api/public/covers/album/" + id.String() + "?exp=" + auth.FormatExp(exp) + "&sig=" + sig,
		ExpiresAt: exp,
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// Same-hour sign calls return identical URLs; let intermediaries cache
	// briefly so the renderer's per-track calls stay cheap.
	w.Header().Set("Cache-Control", "private, max-age=60")
	_ = json.NewEncoder(w).Encode(resp)
}

// PublicAlbumCover serves an album cover when called with a valid HMAC
// signature. No session auth — the signature *is* the auth token. Served
// with a long public Cache-Control so Discord's CDN can cache the image.
func (h *Tracks) PublicAlbumCover(w http.ResponseWriter, r *http.Request) {
	if len(h.CoverSignKey) == 0 {
		http.Error(w, "signing not configured", http.StatusServiceUnavailable)
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	q := r.URL.Query()
	expRaw := q.Get("exp")
	sig := q.Get("sig")
	exp, err := strconv.ParseInt(expRaw, 10, 64)
	if err != nil {
		http.Error(w, "bad exp", http.StatusBadRequest)
		return
	}
	if err := auth.VerifyCoverURL(h.CoverSignKey, "album", id.String(), sig, exp, time.Now()); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	key, err := h.Library.AlbumCoverPath(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	h.servePublicStorageObject(w, r, key, exp)
}

// servePublicStorageObject is the cookie-less variant of serveStorageObject.
// It emits a *public* Cache-Control so Discord's media proxy keeps the image
// cached for the lifetime of the signature.
func (h *Tracks) servePublicStorageObject(w http.ResponseWriter, r *http.Request, key string, exp int64) {
	body, info, err := h.Storage.Get(r.Context(), key)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer body.Close()
	ct := info.ContentType
	if ct == "" {
		ct = contentTypeForExt(filepath.Ext(key))
	}
	remaining := max(exp-time.Now().Unix(), 60)
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age="+strconv.FormatInt(remaining, 10)+", immutable")
	http.ServeContent(w, r, filepath.Base(key), zeroTime(), body)
}

func (h *Tracks) serveStorageObject(w http.ResponseWriter, r *http.Request, key string, maxSize int) {
	body, info, err := h.Storage.Get(r.Context(), key)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer body.Close()
	ct := info.ContentType
	if ct == "" {
		ct = contentTypeForExt(filepath.Ext(key))
	}
	if maxSize > 0 {
		if ok := h.serveResizedImage(w, r, body, key, ct, maxSize); ok {
			return
		}
		if _, err := body.Seek(0, io.SeekStart); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	// No modtime from the Storage interface; use zero (disables 304 handling).
	http.ServeContent(w, r, filepath.Base(key), zeroTime(), body)
}

func remoteCoverURLForSize(cover library.RemoteCover, maxSize int) string {
	if cover.CoverURL != "" {
		return cover.CoverURL
	}
	if strings.EqualFold(cover.Source, trackref.SourceTIDAL) && cover.CoverID != "" {
		return tidal.CoverURL(cover.CoverID, tidalCoverSize(maxSize))
	}
	return ""
}

func tidalCoverSize(maxSize int) int {
	switch {
	case maxSize <= 80:
		return 80
	case maxSize <= 640:
		return 640
	default:
		return 1280
	}
}

func (h *Tracks) serveRemoteCover(w http.ResponseWriter, r *http.Request, rawURL string) {
	u, err := allowedRemoteCoverURL(rawURL)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	if err != nil {
		http.Error(w, "bad cover url", http.StatusBadGateway)
		return
	}
	req.Header.Set("User-Agent", httpx.BrowserUserAgent)
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Referer", "https://tidal.com/")
	req.Header.Set("Sec-Fetch-Dest", "image")
	req.Header.Set("Sec-Fetch-Mode", "no-cors")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	resp, err := remoteCoverHTTPClient.Do(req)
	if err != nil {
		h.log().Warn("remote cover fetch failed", "host", u.Hostname(), "err", err)
		http.Error(w, "cover fetch failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		h.log().Warn("remote cover fetch non-2xx", "host", u.Hostname(), "status", resp.StatusCode)
		http.Redirect(w, r, u.String(), http.StatusFound)
		return
	}
	if resp.ContentLength > maxRemoteCoverBytes {
		http.Error(w, "cover too large", http.StatusBadGateway)
		return
	}
	ct := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if ct == "" {
		ct = contentTypeForExt(filepath.Ext(u.Path))
	}
	if !strings.HasPrefix(strings.ToLower(ct), "image/") {
		h.log().Warn("remote cover fetch returned non-image", "host", u.Hostname(), "content_type", ct)
		http.Error(w, "cover fetch failed", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	if resp.ContentLength > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(resp.ContentLength, 10))
	}
	if _, err := io.Copy(w, io.LimitReader(resp.Body, maxRemoteCoverBytes)); err != nil {
		h.log().Warn("remote cover copy failed", "host", u.Hostname(), "err", err)
	}
}

func allowedRemoteCoverURL(rawURL string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" {
		return nil, errors.New("remote cover URL must be HTTPS")
	}
	if strings.ToLower(u.Hostname()) != "resources.tidal.com" {
		return nil, errors.New("remote cover host is not allowed")
	}
	return u, nil
}

func parseCoverMaxSize(r *http.Request) int {
	raw := strings.TrimSpace(r.URL.Query().Get("size"))
	if raw == "" {
		return maxServedCoverDimension
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return maxServedCoverDimension
	}
	if n > maxServedCoverDimension {
		return maxServedCoverDimension
	}
	return n
}

func (h *Tracks) serveResizedImage(
	w http.ResponseWriter,
	r *http.Request,
	body io.ReadSeeker,
	key string,
	contentType string,
	maxSize int,
) bool {
	thumbKey, thumbType := thumbnailCacheKey(key, maxSize)
	if cached, _, err := h.Storage.Get(r.Context(), thumbKey); err == nil {
		defer cached.Close()
		w.Header().Set("Content-Type", thumbType)
		w.Header().Set("Cache-Control", "private, max-age=86400")
		http.ServeContent(w, r, path.Base(thumbKey), zeroTime(), cached)
		return true
	}
	src, _, err := image.Decode(body)
	if err != nil {
		return false
	}
	bounds := src.Bounds()
	dstW, dstH, _ := thumbnailDimensions(bounds.Dx(), bounds.Dy(), maxSize)

	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, bounds, xdraw.Over, nil)

	var buf bytes.Buffer
	outType := thumbType
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 82}); err != nil {
		return false
	}

	if _, err := h.Storage.Put(
		r.Context(),
		thumbKey,
		bytes.NewReader(buf.Bytes()),
		int64(buf.Len()),
		outType,
	); err != nil {
		w.Header().Set("Content-Type", outType)
		w.Header().Set("Cache-Control", "private, max-age=86400")
		http.ServeContent(w, r, path.Base(thumbKey), zeroTime(), bytes.NewReader(buf.Bytes()))
		return true
	}

	w.Header().Set("Content-Type", outType)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, path.Base(thumbKey), zeroTime(), bytes.NewReader(buf.Bytes()))
	return true
}

func thumbnailDimensions(width int, height int, maxSize int) (int, int, bool) {
	if width <= 0 || height <= 0 || maxSize <= 0 {
		return width, height, false
	}
	if width <= maxSize && height <= maxSize {
		return width, height, false
	}
	if width >= height {
		return maxSize, max(1, int(float64(height)*float64(maxSize)/float64(width))), true
	}
	return max(1, int(float64(width)*float64(maxSize)/float64(height))), maxSize, true
}

func thumbnailCacheKey(key string, maxSize int) (string, string) {
	outType := "image/jpeg"
	ext := ".jpg"
	base := strings.TrimPrefix(key, "/")
	base = strings.TrimSuffix(base, path.Ext(base))
	return path.Join("cover-thumbs", strconv.Itoa(maxSize), base+ext), outType
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

// pathWithinAnyRoot returns true when p lives inside any of the configured
// roots. Prevents a stale DB row with a path outside every root from being
// served.
func pathWithinAnyRoot(roots []string, p string) bool {
	return pathsafe.WithinAnyRoot(roots, p)
}

// pathWithin reports whether p lies inside dir (or equals it). Used to keep
// file removals scoped — e.g. so admin track deletion never unlinks anything
// under MUSIC_ROOT/.users/.
func pathWithin(dir, p string) bool {
	ok, err := pathsafe.WithinRoot(dir, p)
	return err == nil && ok
}

func audioContentType(format, path string) string {
	switch strings.ToLower(format) {
	case "mp3":
		return "audio/mpeg"
	case "flac":
		return "audio/flac"
	case "m4a", "mp4", "aac":
		return "audio/mp4"
	case "webm":
		return "audio/webm"
	case "mov":
		return "video/quicktime"
	case "ogg":
		return "audio/ogg"
	case "opus":
		return "audio/ogg; codecs=opus"
	case "wav":
		return "audio/wav"
	}
	return contentTypeForExt(filepath.Ext(path))
}

func contentTypeForExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".mp3":
		return "audio/mpeg"
	case ".flac":
		return "audio/flac"
	case ".m4a", ".mp4", ".aac":
		return "audio/mp4"
	case ".webm":
		return "audio/webm"
	case ".mov":
		return "video/quicktime"
	case ".ogg":
		return "audio/ogg"
	case ".opus":
		return "audio/ogg; codecs=opus"
	case ".wav":
		return "audio/wav"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	}
	return "application/octet-stream"
}
