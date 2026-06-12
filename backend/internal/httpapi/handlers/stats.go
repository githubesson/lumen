package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/storage"
)

type Stats struct {
	Library   *library.Store
	Playlists *playlists.Store
	// Storage materializes album covers for the Replay share image.
	Storage storage.Storage
}

// ── Wire types (JSON) ───────────────────────────────────────────────────────

type replayHeadlineArtistResp struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Plays int    `json:"plays"`
}

type replaySummaryResp struct {
	TotalPlays     int                       `json:"total_plays"`
	TotalMs        int64                     `json:"total_ms"`
	UniqueTracks   int                       `json:"unique_tracks"`
	UniqueArtists  int                       `json:"unique_artists"`
	HeadlineArtist *replayHeadlineArtistResp `json:"headline_artist,omitempty"`
}

type replayTrackResp struct {
	trackListItemResp
	Plays int `json:"plays"`
}

type replayArtistResp struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Plays int    `json:"plays"`
}

type replayAlbumResp struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Artist string `json:"artist,omitempty"`
	Plays  int    `json:"plays"`
}

type replayGenreResp struct {
	Genre string `json:"genre"`
	Plays int    `json:"plays"`
}

type replayActivityResp struct {
	BucketStart string `json:"bucket_start"`
	Plays       int    `json:"plays"`
}

type replayResp struct {
	Summary        replaySummaryResp    `json:"summary"`
	TopTracks      []replayTrackResp    `json:"top_tracks"`
	TopArtists     []replayArtistResp   `json:"top_artists"`
	TopAlbums      []replayAlbumResp    `json:"top_albums"`
	TopGenres      []replayGenreResp    `json:"top_genres"`
	Activity       []replayActivityResp `json:"activity"`
	Bucket         string               `json:"bucket"`
	AvailableYears []int                `json:"available_years"`
}

// ── Handlers ────────────────────────────────────────────────────────────────

// Replay returns the user's listening stats for an optional time window.
//
// Query params (all optional):
//
//	from   RFC3339 timestamp (inclusive)
//	to     RFC3339 timestamp (exclusive)
//	bucket day|week|month   (auto-chosen if omitted)
func (h *Stats) Replay(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}

	q := r.URL.Query()
	from, ok := parseOptionalTime(q.Get("from"))
	if !ok {
		http.Error(w, "bad from", http.StatusBadRequest)
		return
	}
	to, ok := parseOptionalTime(q.Get("to"))
	if !ok {
		http.Error(w, "bad to", http.StatusBadRequest)
		return
	}
	var bucket library.ReplayBucket
	switch strings.ToLower(q.Get("bucket")) {
	case "day":
		bucket = library.BucketDay
	case "week":
		bucket = library.BucketWeek
	case "month":
		bucket = library.BucketMonth
	case "":
		// leave empty; library picks based on window
	default:
		http.Error(w, "bad bucket", http.StatusBadRequest)
		return
	}

	data, err := h.Library.ReplayStats(r.Context(), library.ReplayStatsParams{
		ViewerID: u.ID,
		From:     from,
		To:       to,
		Bucket:   bucket,
	})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, toReplayResp(data))
}

type generateReplayPlaylistReq struct {
	From  string `json:"from,omitempty"`
	To    string `json:"to,omitempty"`
	Name  string `json:"name"`
	Limit int    `json:"limit,omitempty"`
}

// GeneratePlaylist creates a private playlist from the user's top tracks for
// the same window the Replay page is showing.
func (h *Stats) GeneratePlaylist(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}

	var req generateReplayPlaylistReq
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		http.Error(w, "name required", http.StatusBadRequest)
		return
	}
	from, ok := parseOptionalTime(req.From)
	if !ok {
		http.Error(w, "bad from", http.StatusBadRequest)
		return
	}
	to, ok := parseOptionalTime(req.To)
	if !ok {
		http.Error(w, "bad to", http.StatusBadRequest)
		return
	}
	if req.Limit <= 0 {
		req.Limit = 50
	}

	ids, err := h.Library.ReplayTopTrackIDs(r.Context(), library.ReplayStatsParams{
		ViewerID: u.ID,
		From:     from,
		To:       to,
	}, req.Limit)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if len(ids) == 0 {
		http.Error(w, "no plays in that window", http.StatusUnprocessableEntity)
		return
	}

	p, err := h.Playlists.Create(r.Context(), u.ID, req.Name, "", playlists.VisibilityPrivate)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := h.Playlists.AddTracks(r.Context(), p.ID, ids, u.ID); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, toPlaylistResp(p, "owner"))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// parseOptionalTime returns (nil, true) for empty input, (&t, true) for a valid
// RFC3339 timestamp, and (nil, false) otherwise.
func parseOptionalTime(s string) (*time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, true
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return nil, false
	}
	return &t, true
}

func toReplayResp(d *library.ReplayData) replayResp {
	out := replayResp{
		Summary: replaySummaryResp{
			TotalPlays:    d.Summary.TotalPlays,
			TotalMs:       d.Summary.TotalMs,
			UniqueTracks:  d.Summary.UniqueTracks,
			UniqueArtists: d.Summary.UniqueArtists,
		},
		TopTracks:      make([]replayTrackResp, 0, len(d.TopTracks)),
		TopArtists:     make([]replayArtistResp, 0, len(d.TopArtists)),
		TopAlbums:      make([]replayAlbumResp, 0, len(d.TopAlbums)),
		TopGenres:      make([]replayGenreResp, 0, len(d.TopGenres)),
		Activity:       make([]replayActivityResp, 0, len(d.Activity)),
		Bucket:         string(d.Bucket),
		AvailableYears: d.AvailableYears,
	}
	if d.AvailableYears == nil {
		out.AvailableYears = []int{}
	}
	if d.Summary.HeadlineArtist != nil {
		out.Summary.HeadlineArtist = &replayHeadlineArtistResp{
			ID:    d.Summary.HeadlineArtist.ID.String(),
			Name:  d.Summary.HeadlineArtist.Name,
			Plays: d.Summary.HeadlineArtist.Plays,
		}
	}
	for _, t := range d.TopTracks {
		row := replayTrackResp{
			trackListItemResp: trackListItemResp{
				ID:         t.ID.String(),
				Title:      t.Title,
				AlbumTitle: t.AlbumTitle,
				TrackNo:    t.TrackNo,
				DurationMS: t.DurationMS,
				Artist:     t.Artist,
				Aka:        t.Aka,
				Owned:      t.Owned,
			},
			Plays: t.Plays,
		}
		if t.AlbumID != nil {
			row.AlbumID = t.AlbumID.String()
		}
		out.TopTracks = append(out.TopTracks, row)
	}
	for _, a := range d.TopArtists {
		out.TopArtists = append(out.TopArtists, replayArtistResp{
			ID: a.ID.String(), Name: a.Name, Plays: a.Plays,
		})
	}
	for _, a := range d.TopAlbums {
		out.TopAlbums = append(out.TopAlbums, replayAlbumResp{
			ID: a.ID.String(), Title: a.Title, Artist: a.Artist, Plays: a.Plays,
		})
	}
	for _, g := range d.TopGenres {
		out.TopGenres = append(out.TopGenres, replayGenreResp{Genre: g.Genre, Plays: g.Plays})
	}
	for _, b := range d.Activity {
		out.Activity = append(out.Activity, replayActivityResp{
			BucketStart: b.BucketStart.UTC().Format(time.RFC3339),
			Plays:       b.Plays,
		})
	}
	return out
}
