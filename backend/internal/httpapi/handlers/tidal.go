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
	"github.com/githubesson/lumen/internal/tidal"
)

type TIDAL struct {
	TIDAL *tidal.Client
	// Library, when set, caches viewed albums and swaps saved copies into
	// their track lists.
	Library *library.Store
}

type tidalAlbumResp struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Artist      string   `json:"artist,omitempty"`
	Artists     []string `json:"artists,omitempty"`
	ReleaseYear int      `json:"release_year,omitempty"`
	// SavedCount tracks are served from the library; LibraryAlbumID is the
	// library album copying this release, if any.
	SavedCount     int    `json:"saved_count,omitempty"`
	LibraryAlbumID string `json:"library_album_id,omitempty"`
	// QueuedCount tracks are waiting for an album download.
	QueuedCount int                 `json:"queued_count,omitempty"`
	TrackCount  int                 `json:"track_count"`
	DurationMS  int                 `json:"duration_ms"`
	CoverURL    string              `json:"cover_url,omitempty"`
	Tracks      []trackListItemResp `json:"tracks"`
}

type tidalArtistProfileResp struct {
	Name     string `json:"name"`
	CoverURL string `json:"cover_url,omitempty"`
}

func (h *TIDAL) Album(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	limit, offset := pageParams(r.URL.Query())
	// An unpaged request is the album page itself: it gets the whole
	// release, not the proxy's first page, so counts and the download
	// control cover every track.
	unpaged := r.URL.Query().Get("limit") == "" && offset == 0
	err := tidal.ErrNotConfigured
	var album tidal.Album
	if h.TIDAL != nil {
		album, err = h.TIDAL.Album(r.Context(), id, limit, offset)
		if err == nil && unpaged && len(album.Tracks) < album.TrackCount {
			if full, ferr := h.TIDAL.FullAlbum(r.Context(), id); ferr == nil {
				album = full
			}
		}
	}
	partial := err == nil && len(album.Tracks) < album.TrackCount
	if h.Library != nil {
		if offset == 0 && err == nil && !partial {
			// A full fetch updates the stored record, which then also lists
			// the tracks TIDAL has since dropped. Only releases the library
			// references are stored from a page view; downloads store the rest.
			if ref, rerr := h.Library.TIDALAlbumReferenced(r.Context(), id); rerr == nil && ref {
				if serr := h.Library.SaveTIDALAlbum(r.Context(), album); serr != nil {
					slog.Warn("tidal album cache write failed", "album", album.ID, "err", serr)
				}
			}
		}
		// The stored record outlives the release on TIDAL. Serve it when
		// TIDAL can't (any page); in place of a full fetch, so dropped tracks
		// show; and to the album page when only part could be fetched.
		if err != nil || (offset == 0 && (!partial || unpaged)) {
			if cached, _, cerr := h.Library.TIDALAlbum(r.Context(), id); cerr == nil &&
				(err != nil || !partial || len(cached.Tracks) >= len(album.Tracks)) {
				album, err = cached, nil
				if !unpaged {
					album.Tracks = pageOf(album.Tracks, offset, limit)
				}
			}
		}
	}
	if err != nil {
		if errors.Is(err, tidal.ErrNotConfigured) {
			http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
			return
		}
		if errors.Is(err, tidal.ErrRefused) {
			http.Error(w, tidalRefusalText("TIDAL refused this album", err), http.StatusBadGateway)
			return
		}
		http.Error(w, "tidal album unavailable", http.StatusBadGateway)
		return
	}
	out := makeTIDALAlbumResp(album)
	if h.Library != nil {
		h.withLibrary(r.Context(), &out, album, u.ID)
	}
	writeJSON(w, http.StatusOK, out)
}

// pageOf applies an explicit page request to a stored track list, with the
// same limit defaults the TIDAL client uses.
func pageOf(tracks []tidal.Track, offset, limit int) []tidal.Track {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if offset < 0 || offset >= len(tracks) {
		return []tidal.Track{}
	}
	return tracks[offset:min(len(tracks), offset+limit)]
}

// withLibrary swaps the viewer's library copies into the release's track
// list and reports downloads queued for it. Library failures only cost the
// enrichment.
func (h *TIDAL) withLibrary(ctx context.Context, out *tidalAlbumResp, album tidal.Album, viewerID uuid.UUID) {
	var localAlbum *uuid.UUID
	if id, err := h.Library.LocalAlbumForTIDAL(ctx, album.ID, viewerID); err == nil {
		localAlbum = &id
		out.LibraryAlbumID = id.String()
	}
	if n, err := h.Library.TIDALAlbumQueued(ctx, album.ID); err == nil {
		out.QueuedCount = n
	}
	// Library tracks that match no entry aren't appended here (this may be
	// one page of the release); the library album's page shows them.
	merged, err := mergeWithLibrary(ctx, h.Library, album, localAlbum, viewerID, false)
	if err != nil {
		slog.Warn("tidal album library merge failed", "album", album.ID, "err", err)
		return
	}
	out.Tracks = merged.Tracks
	out.SavedCount = merged.SavedCount
}

func makeTIDALAlbumResp(album tidal.Album) tidalAlbumResp {
	out := tidalAlbumResp{
		ID:          album.ID,
		Title:       album.Title,
		Artist:      album.Artist,
		Artists:     album.Artists,
		ReleaseYear: album.ReleaseYear,
		TrackCount:  album.TrackCount,
		DurationMS:  album.DurationMS,
		CoverURL:    proxyRemoteCoverURL(album.CoverURL, remoteCoverWarmFull),
		Tracks:      make([]trackListItemResp, 0, len(album.Tracks)),
	}
	for _, it := range album.Tracks {
		out.Tracks = append(out.Tracks, tidalAlbumTrackResp(album, it))
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

func (h *TIDAL) Artist(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUser(w, r); !ok {
		return
	}
	if h.TIDAL == nil {
		http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
		return
	}
	result, err := h.TIDAL.ArtistReleases(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, tidal.ErrNotConfigured) {
			http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
			return
		}
		if errors.Is(err, tidal.ErrRefused) {
			http.Error(w, tidalRefusalText("TIDAL refused this artist", err), http.StatusBadGateway)
			return
		}
		http.Error(w, "tidal artist unavailable", http.StatusBadGateway)
		return
	}
	out := struct {
		Artist   *tidalArtistProfileResp `json:"artist,omitempty"`
		Albums   []searchAlbumResp       `json:"albums"`
		Tracks   []trackListItemResp     `json:"tracks"`
		Warnings []string                `json:"warnings,omitempty"`
	}{Albums: []searchAlbumResp{}, Tracks: []trackListItemResp{}, Warnings: result.Warnings}
	if result.Artist != nil {
		out.Artist = &tidalArtistProfileResp{Name: result.Artist.Name, CoverURL: proxyRemoteCoverURL(result.Artist.CoverURL, remoteCoverWarmFull)}
	}
	for _, album := range result.Albums {
		out.Albums = append(out.Albums, makeSearchTIDALAlbumResp(album))
	}
	for _, track := range result.Tracks {
		out.Tracks = append(out.Tracks, makeTIDALTrackResp(track))
	}
	writeJSON(w, http.StatusOK, out)
}

type tidalTrackArtistResp struct {
	Name string `json:"name"`
	Role string `json:"role"` // "main" or "featured"
}

type tidalTrackCreditResp struct {
	Role  string   `json:"role"`
	Names []string `json:"names"`
}

// tidalTrackResp is TIDAL's side of a track's info view, beyond what the
// track's row stores.
type tidalTrackResp struct {
	ID          string                 `json:"id"`
	Artists     []tidalTrackArtistResp `json:"artists"`
	ReleaseDate string                 `json:"release_date,omitempty"`
	Copyright   string                 `json:"copyright,omitempty"`
	ISRC        string                 `json:"isrc,omitempty"`
	BPM         int                    `json:"bpm,omitempty"`
	Key         string                 `json:"key,omitempty"`
	// StreamedQuality is the tier of the stream this server is serving for
	// the track right now, when it has one; MaxQuality the best it would ask
	// for, which playback can fall below. Each is HI_RES_LOSSLESS, LOSSLESS,
	// HIGH or LOW.
	StreamedQuality string                 `json:"streamed_quality,omitempty"`
	MaxQuality      string                 `json:"max_quality,omitempty"`
	Channels        int                    `json:"channels,omitempty"`
	Credits         []tidalTrackCreditResp `json:"credits"`
	// CreditsFailed means Credits is empty because they couldn't be loaded.
	CreditsFailed bool `json:"credits_failed,omitempty"`
}

// Track serves a TIDAL track's details, fetched from TIDAL on each request.
func (h *TIDAL) Track(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUser(w, r); !ok {
		return
	}
	if h.TIDAL == nil {
		http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
		return
	}
	d, err := h.TIDAL.TrackDetails(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		switch {
		case errors.Is(err, tidal.ErrInvalidID):
			http.Error(w, "invalid tidal track id", http.StatusBadRequest)
		case errors.Is(err, tidal.ErrNotConfigured):
			http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
		case errors.Is(err, tidal.ErrRefused):
			http.Error(w, tidalRefusalText("TIDAL refused this track", err), http.StatusBadGateway)
		default:
			http.Error(w, "tidal track unavailable", http.StatusBadGateway)
		}
		return
	}
	out := tidalTrackResp{
		ID:              d.ID,
		Artists:         make([]tidalTrackArtistResp, 0, len(d.MainArtists)+len(d.FeaturedArtists)),
		ReleaseDate:     d.ReleaseDate,
		Copyright:       d.Copyright,
		ISRC:            d.ISRC,
		BPM:             d.BPM,
		Key:             d.Key,
		StreamedQuality: d.StreamedQuality,
		MaxQuality:      d.MaxQuality,
		Credits:         make([]tidalTrackCreditResp, 0, len(d.Credits)),
		CreditsFailed:   d.CreditsFailed,
	}
	// Immersive formats are never requested, so a track TIDAL offers in
	// stereo streams in stereo.
	if d.Stereo {
		out.Channels = 2
	}
	for _, name := range d.MainArtists {
		out.Artists = append(out.Artists, tidalTrackArtistResp{Name: name, Role: "main"})
	}
	for _, name := range d.FeaturedArtists {
		out.Artists = append(out.Artists, tidalTrackArtistResp{Name: name, Role: "featured"})
	}
	for _, c := range d.Credits {
		out.Credits = append(out.Credits, tidalTrackCreditResp{Role: c.Role, Names: c.Names})
	}
	writeJSON(w, http.StatusOK, out)
}
