package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/models"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func TestTIDALArtistFailureResponse(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		body    string
		warning string
		albums  int
		artist  *tidalArtistProfileResp
	}{
		{"total failure", 502, `{"detail":"private upstream failure"}`, "", 0, nil},
		{"partial failure", 200, `{"albums":{"items":[{"id":456,"title":"Release"}]},"tracks":[],"failed_sections":["singles"]}`, "Couldn't load singles and EPs.", 1, nil},
		{"incomplete empty", 200, `{"albums":{"items":[]},"tracks":[],"failed_sections":["albums"]}`, "Couldn't load albums.", 0, nil},
		{"confirmed empty", 200, `{"albums":{"items":[]},"tracks":[],"failed_sections":[]}`, "", 0, nil},
		{"profile", 200, `{"artist":{"name":"Artist","picture":"a-b-c"},"albums":{"items":[]},"tracks":[],"failed_sections":[]}`, "", 0, &tidalArtistProfileResp{
			Name:     "Artist",
			CoverURL: "/api/covers/remote?url=https%3A%2F%2Fresources.tidal.com%2Fimages%2Fa%2Fb%2Fc%2F750x750.jpg",
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/lumen/artist" || r.URL.Query().Get("id") != "123" {
					t.Errorf("unexpected request %s", r.URL)
				}
				w.WriteHeader(tc.status)
				_, _ = fmt.Fprint(w, tc.body)
			}))
			defer proxy.Close()
			h := &TIDAL{TIDAL: tidal.NewClient(tidal.Config{HifiAPIURL: proxy.URL})}
			sessions := &activitySocketSessions{cookieName: "session", user: &models.User{ID: uuid.New()}}
			router := chi.NewRouter()
			router.Use(middleware.Authenticate(sessions))
			router.Get("/api/tidal/artists/{id}", h.Artist)
			r := httptest.NewRequest(http.MethodGet, "/api/tidal/artists/123", nil)
			r.AddCookie(&http.Cookie{Name: "session", Value: "test"})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body)
			}
			if tc.status == http.StatusBadGateway {
				if w.Body.String() != "tidal artist unavailable\n" {
					t.Fatal(w.Body.String())
				}
				return
			}
			var result struct {
				Artist   *tidalArtistProfileResp `json:"artist"`
				Albums   []searchAlbumResp       `json:"albums"`
				Tracks   []trackListItemResp     `json:"tracks"`
				Warnings []string                `json:"warnings"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Albums == nil || result.Tracks == nil || len(result.Albums) != tc.albums {
				t.Fatalf("bad data: %+v", result)
			}
			if (result.Artist == nil) != (tc.artist == nil) || result.Artist != nil && *result.Artist != *tc.artist {
				t.Fatalf("artist = %+v, want %+v", result.Artist, tc.artist)
			}
			if tc.warning == "" && len(result.Warnings) != 0 || tc.warning != "" && (len(result.Warnings) != 1 || result.Warnings[0] != tc.warning) {
				t.Fatalf("bad warnings: %+v", result.Warnings)
			}
		})
	}
}

func TestTIDALAlbumPageListsWholeRelease(t *testing.T) {
	// 150 tracks, served 100 per page.
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		offset := 0
		fmt.Sscan(r.URL.Query().Get("offset"), &offset)
		limit := 100
		items := ""
		for i := offset; i < 150 && i < offset+limit; i++ {
			if items != "" {
				items += ","
			}
			items += fmt.Sprintf(`{"type":"track","item":{"id":%d,"title":"Track %d","trackNumber":%d}}`, 1000+i, i+1, i+1)
		}
		_, _ = fmt.Fprintf(w, `{"data":{"id":7,"title":"Long","numberOfTracks":150,"items":[%s]}}`, items)
	}))
	defer proxy.Close()
	h := &TIDAL{TIDAL: tidal.NewClient(tidal.Config{HifiAPIURL: proxy.URL})}
	sessions := &activitySocketSessions{cookieName: "session", user: &models.User{ID: uuid.New()}}
	router := chi.NewRouter()
	router.Use(middleware.Authenticate(sessions))
	router.Get("/api/tidal/albums/{id}", h.Album)
	for path, want := range map[string]int{
		"/api/tidal/albums/7":                    150, // the album page: whole release
		"/api/tidal/albums/7?limit=100&offset=0": 100, // explicit paging stays paged
	} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.AddCookie(&http.Cookie{Name: "session", Value: "test"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var got tidalAlbumResp
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
		if len(got.Tracks) != want {
			t.Fatalf("%s: %d tracks, want %d", path, len(got.Tracks), want)
		}
	}
}
