package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sync"
	"testing"

	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/models"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/google/uuid"
)

type searchTestLibrary struct {
	mu          sync.Mutex
	calls       []string
	viewer      uuid.UUID
	favoriteErr error
}

func (s *searchTestLibrary) record(kind string, viewer uuid.UUID, offset int, query string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, fmt.Sprintf("%s:%d:%s", kind, offset, query))
	if viewer != s.viewer {
		panic("search lost the viewer scope")
	}
}
func (s *searchTestLibrary) FavoriteIDs(context.Context, uuid.UUID) (map[uuid.UUID]struct{}, error) {
	return nil, s.favoriteErr
}
func (s *searchTestLibrary) ListTracks(_ context.Context, p library.ListTracksParams) ([]library.TrackListItem, error) {
	s.record("track", p.ViewerID, p.Offset, p.Query)
	return []library.TrackListItem{{ID: uuid.New(), Title: "Song"}}, nil
}
func (s *searchTestLibrary) ListAlbums(_ context.Context, viewer uuid.UUID, _, offset int, query string) ([]library.AlbumListItem, error) {
	s.record("album", viewer, offset, query)
	return []library.AlbumListItem{{ID: uuid.New(), Title: "Album"}}, nil
}
func (s *searchTestLibrary) ListArtists(_ context.Context, viewer uuid.UUID, _, offset int, query string) ([]library.ArtistListItem, error) {
	s.record("artist", viewer, offset, query)
	return []library.ArtistListItem{{ID: uuid.New(), Name: "Artist"}}, nil
}

func runSearch(t *testing.T, h *Search, viewer uuid.UUID, query string) *httptest.ResponseRecorder {
	t.Helper()
	sessions := &activitySocketSessions{cookieName: "session", user: &models.User{ID: viewer}}
	r := httptest.NewRequest(http.MethodGet, "/api/search?"+query, nil)
	r.AddCookie(&http.Cookie{Name: "session", Value: "test"})
	w := httptest.NewRecorder()
	middleware.Authenticate(sessions)(http.HandlerFunc(h.Search)).ServeHTTP(w, r)
	return w
}

func TestSearchTypes(t *testing.T) {
	for _, kind := range []string{"", "track", "song", "songs", "tracks", "album", "albums", "artist", "artists", "all"} {
		t.Run(kind, func(t *testing.T) {
			store := &searchTestLibrary{viewer: uuid.New()}
			w := runSearch(t, &Search{Library: store}, store.viewer, "q=hello&type="+kind+"&sources=local&limit=1")
			if w.Code != http.StatusOK {
				t.Fatal(w.Body.String())
			}
			var resp searchResp
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatal(err)
			}
			tracks, albums, artists := 0, 0, 0
			switch kind {
			case "album", "albums":
				albums = 1
			case "artist", "artists":
				artists = 1
			case "all":
				tracks, albums, artists = 1, 1, 1
			default:
				tracks = 1
			}
			if len(resp.Tracks) != tracks || len(resp.Albums) != albums || len(resp.Artists) != artists {
				t.Fatalf("wrong result types: %s", w.Body.String())
			}
			if resp.Tracks == nil || resp.Albums == nil || resp.Artists == nil {
				t.Fatal("empty collections must be arrays")
			}
			if len(store.calls) != tracks+albums+artists {
				t.Fatalf("queried excluded types: %v", store.calls)
			}
			if len(resp.NextOffsets) != len(store.calls) {
				t.Fatal("missing per-type continuation")
			}
		})
	}
}

func TestSearchContinuationValidation(t *testing.T) {
	for _, raw := range []string{"type=invalid", "type=album&streams=local", "type=all&streams=unknown", "local_offset=-1", "local_offset=nope", "type=album&local_album_offset=-1"} {
		w := runSearch(t, &Search{}, uuid.New(), raw)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d", raw, w.Code)
		}
	}
	store := &searchTestLibrary{viewer: uuid.New()}
	w := runSearch(t, &Search{Library: store}, store.viewer, "type=all&q=hello&sources=local&streams=local_album&local_album_offset=7&offset=100")
	if w.Code != http.StatusOK || !reflect.DeepEqual(store.calls, []string{"album:7:hello"}) {
		t.Fatalf("continuation restarted an exhausted stream: %v %s", store.calls, w.Body.String())
	}
	w = runSearch(t, &Search{}, uuid.New(), "type=all&streams=")
	if w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
}

func TestSearchPartialTIDALFailureAndSourceOffsets(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]url.Values{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen[r.URL.Path] = r.URL.Query()
		mu.Unlock()
		if r.URL.Path == "/lumen/search/albums" {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/lumen/search/artists" {
			_, _ = fmt.Fprint(w, `{"data":{"items":[{"id":12,"name":"Remote artist"}]}}`)
			return
		}
		_, _ = fmt.Fprint(w, `{"data":{"items":[{"id":42,"title":"Remote song"}]}}`)
	}))
	defer server.Close()
	store := &searchTestLibrary{viewer: uuid.New()}
	h := &Search{Library: store, TIDAL: tidal.NewClient(tidal.Config{HifiAPIURL: server.URL})}
	w := runSearch(t, h, store.viewer, "q=hello&type=all&limit=1&tidal_offset=4&tidal_artist_offset=9")
	var resp searchResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(w.Body.String())
	}
	if len(resp.Warnings) != 1 || len(resp.Tracks) != 2 || len(resp.Albums) != 1 || len(resp.Artists) != 2 {
		t.Fatalf("partial results lost: %s", w.Body.String())
	}
	if resp.NextOffsets["tidal"] != 5 || resp.NextOffsets["tidal_artist"] != 10 {
		t.Fatal(resp.NextOffsets)
	}
	if seen["/search/"].Get("offset") != "4" || seen["/lumen/search/artists"].Get("offset") != "9" {
		t.Fatal(seen)
	}
	if resp.Artists[1].ID != "tidal:12" || resp.Artists[1].SourceID != "12" {
		t.Fatal("remote identity lost")
	}
}

func TestSearchFavoriteFailureDoesNotAffectAlbumSearch(t *testing.T) {
	store := &searchTestLibrary{viewer: uuid.New(), favoriteErr: errors.New("database failure")}
	for _, kind := range []string{"album", "artist"} {
		if w := runSearch(t, &Search{Library: store}, store.viewer, "sources=local&type="+kind); w.Code != http.StatusOK {
			t.Fatal(w.Body.String())
		}
	}
	if w := runSearch(t, &Search{Library: store}, store.viewer, "sources=local&type=track"); w.Code != http.StatusInternalServerError {
		t.Fatal("favorite error returned stale track state")
	}
	w := httptest.NewRecorder()
	(&Search{}).Search(w, httptest.NewRequest(http.MethodGet, "/api/search?type=all", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatal("search must require authentication")
	}
}

func TestSearchUnconfiguredTIDAL(t *testing.T) {
	for _, client := range []*tidal.Client{nil, tidal.NewClient(tidal.Config{})} {
		store := &searchTestLibrary{viewer: uuid.New()}
		for _, explicit := range []bool{false, true} {
			query := "q=hello&type=all"
			if explicit {
				query += "&sources=tidal"
			}
			w := runSearch(t, &Search{Library: store, TIDAL: client}, store.viewer, query)
			var resp searchResp
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatal(w.Body.String())
			}
			if explicit && (len(resp.Warnings) != 1 || resp.Warnings[0] != "TIDAL is not configured.") {
				t.Fatal(resp.Warnings)
			}
			if !explicit && (len(resp.Warnings) != 0 || len(resp.Tracks) != 1) {
				t.Fatal(w.Body.String())
			}
		}
		sessions := &activitySocketSessions{cookieName: "session", user: &models.User{ID: store.viewer}}
		r := httptest.NewRequest(http.MethodGet, "/api/tidal/artists/42", nil)
		r.AddCookie(&http.Cookie{Name: "session", Value: "test"})
		w := httptest.NewRecorder()
		middleware.Authenticate(sessions)(http.HandlerFunc((&TIDAL{TIDAL: client}).Artist)).ServeHTTP(w, r)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("unconfigured artist status = %d", w.Code)
		}
	}
}
