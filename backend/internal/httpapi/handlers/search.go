package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/trackref"
	"github.com/google/uuid"
)

type searchLibrary interface {
	FavoriteIDs(context.Context, uuid.UUID) (map[uuid.UUID]struct{}, error)
	ListTracks(context.Context, library.ListTracksParams) ([]library.TrackListItem, error)
	ListAlbums(context.Context, uuid.UUID, int, int, string) ([]library.AlbumListItem, error)
	ListArtists(context.Context, uuid.UUID, int, int, string) ([]library.ArtistListItem, error)
}

type Search struct {
	Library searchLibrary
	TIDAL   *tidal.Client
}

type searchAlbumResp struct {
	albumListResp
	Source   string `json:"source"`
	SourceID string `json:"source_id,omitempty"`
	CoverURL string `json:"cover_url,omitempty"`
}

type searchArtistResp struct {
	artistListResp
	Source   string `json:"source"`
	SourceID string `json:"source_id,omitempty"`
	CoverURL string `json:"cover_url,omitempty"`
}

type searchResp struct {
	NextOffsets map[string]int      `json:"next_offsets"`
	Tracks      []trackListItemResp `json:"tracks"`
	Albums      []searchAlbumResp   `json:"albums"`
	Artists     []searchArtistResp  `json:"artists"`
	Sources     []string            `json:"sources"`
	Warnings    []string            `json:"warnings,omitempty"`
}

type searchStream struct {
	key, source, kind string
	offset            int
}

// Track-only requests retain the original source cursor keys and default.
func searchStreams(q url.Values, sources []string, offset int) ([]searchStream, error) {
	kind := strings.ToLower(strings.TrimSpace(q.Get("type")))
	switch kind {
	case "", "song", "songs", "tracks":
		kind = "track"
	case "albums":
		kind = "album"
	case "artists":
		kind = "artist"
	}
	if kind != "all" && kind != "track" && kind != "album" && kind != "artist" {
		return nil, fmt.Errorf("invalid search type: use all, track, album, or artist")
	}
	allowed := map[string]searchStream{}
	var keys []string
	for _, k := range []string{"track", "album", "artist"} {
		if kind != "all" && kind != k {
			continue
		}
		for _, source := range sources {
			key := source
			if k != "track" {
				key += "_" + k
			}
			allowed[key] = searchStream{key: key, source: source, kind: k, offset: offset}
			keys = append(keys, key)
		}
	}
	// An explicit empty streams value represents an exhausted search.
	if q.Has("streams") {
		keys = nil
		if raw := q.Get("streams"); raw != "" {
			keys = strings.Split(raw, ",")
		}
	}
	seen := map[string]bool{}
	streams := make([]searchStream, 0, len(keys))
	for _, key := range keys {
		stream, ok := allowed[key]
		if !ok {
			return nil, fmt.Errorf("invalid search stream")
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		if raw := q.Get(key + "_offset"); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 0 {
				return nil, fmt.Errorf("invalid search offset")
			}
			stream.offset = n
		}
		streams = append(streams, stream)
	}
	return streams, nil
}

func (h *Search) Search(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	query := strings.TrimSpace(q.Get("q"))
	limit, offset := pageParams(q)
	if limit <= 0 || limit > 50 {
		limit = 25
	}
	sources := parseSources(q.Get("sources"))
	streams, err := searchStreams(q, sources, max(0, offset))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	resp := searchResp{Sources: sources, Tracks: []trackListItemResp{}, Albums: []searchAlbumResp{}, Artists: []searchArtistResp{}, NextOffsets: map[string]int{}}
	type result struct {
		data  searchResp
		count int
		err   error
	}
	results := make([]result, len(streams))
	var wg sync.WaitGroup
	for i, stream := range streams {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i].data, results[i].count, results[i].err = h.searchStream(r.Context(), u.ID, query, limit, stream)
		}()
	}
	wg.Wait()
	for i, result := range results {
		stream := streams[i]
		if result.err != nil {
			if stream.source == trackref.SourceLocal {
				writeStoreError(w, result.err)
				return
			}
			slog.Warn("tidal search failed", "type", stream.kind, "err", result.err)
			resp.Warnings = append(resp.Warnings, "TIDAL "+stream.kind+" search is unavailable. Try again later.")
			continue
		}
		if result.count == limit {
			resp.NextOffsets[stream.key] = stream.offset + result.count
		}
		resp.Tracks = append(resp.Tracks, result.data.Tracks...)
		resp.Albums = append(resp.Albums, result.data.Albums...)
		resp.Artists = append(resp.Artists, result.data.Artists...)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Search) searchStream(ctx context.Context, viewer uuid.UUID, query string, limit int, stream searchStream) (searchResp, int, error) {
	var out searchResp
	if stream.source == trackref.SourceLocal {
		switch stream.kind {
		case "track":
			favs, err := h.Library.FavoriteIDs(ctx, viewer)
			if err != nil {
				return out, 0, err
			}
			items, err := h.Library.ListTracks(ctx, library.ListTracksParams{ViewerID: viewer, Limit: limit, Offset: stream.offset, Query: query})
			for _, item := range items {
				_, favorited := favs[item.ID]
				out.Tracks = append(out.Tracks, makeTrackListItemResp(item, favorited, true))
			}
			return out, len(items), err
		case "album":
			items, err := h.Library.ListAlbums(ctx, viewer, limit, stream.offset, query)
			for _, item := range items {
				out.Albums = append(out.Albums, searchAlbumResp{albumListResp: makeAlbumResp(&library.AlbumDetail{AlbumListItem: item}), Source: trackref.SourceLocal})
			}
			return out, len(items), err
		case "artist":
			items, err := h.Library.ListArtists(ctx, viewer, limit, stream.offset, query)
			for _, item := range items {
				out.Artists = append(out.Artists, searchArtistResp{artistListResp: artistListResp{ID: item.ID.String(), Name: item.Name, TrackCount: item.TrackCount, AlbumCount: item.AlbumCount}, Source: trackref.SourceLocal})
			}
			return out, len(items), err
		}
	}
	if query == "" {
		return out, 0, nil
	}
	if h.TIDAL == nil {
		return out, 0, tidal.ErrNotConfigured
	}
	switch stream.kind {
	case "track":
		items, err := h.TIDAL.SearchTracks(ctx, query, limit, stream.offset)
		for _, item := range items {
			out.Tracks = append(out.Tracks, makeTIDALTrackResp(item))
		}
		return out, len(items), err
	case "album":
		items, count, err := h.TIDAL.SearchAlbums(ctx, query, limit, stream.offset)
		for _, item := range items {
			out.Albums = append(out.Albums, makeSearchTIDALAlbumResp(item))
		}
		return out, count, err
	case "artist":
		items, count, err := h.TIDAL.SearchArtists(ctx, query, limit, stream.offset)
		for _, item := range items {
			out.Artists = append(out.Artists, searchArtistResp{artistListResp: artistListResp{ID: trackref.Remote(trackref.SourceTIDAL, item.ID), Name: item.Name}, Source: trackref.SourceTIDAL, SourceID: item.ID, CoverURL: proxyRemoteCoverURL(item.CoverURL)})
		}
		return out, count, err
	}
	return out, 0, nil
}

func makeSearchTIDALAlbumResp(item tidal.Album) searchAlbumResp {
	return searchAlbumResp{albumListResp: albumListResp{ID: trackref.Remote(trackref.SourceTIDAL, item.ID), Title: item.Title, ArtistName: item.Artist, ReleaseYear: item.ReleaseYear, TrackCount: item.TrackCount, DurationMS: int64(item.DurationMS), HasCover: item.CoverURL != ""}, Source: trackref.SourceTIDAL, SourceID: item.ID, CoverURL: proxyRemoteCoverURL(item.CoverURL)}
}

func makeTIDALTrackResp(it tidal.Track) trackListItemResp {
	return trackListItemResp{ID: trackref.Remote(trackref.SourceTIDAL, it.ID), Source: trackref.SourceTIDAL, SourceID: it.ID, SourceAlbumID: it.AlbumID, Title: it.Title, AlbumTitle: it.AlbumTitle, TrackNo: it.TrackNo, DurationMS: it.DurationMS, Artist: strings.Join(it.Artists, ", "), CoverURL: proxyRemoteCoverURL(it.CoverURL)}
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
