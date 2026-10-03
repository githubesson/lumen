package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"

	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/models"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// refusingTIDAL is a TIDAL client whose hifi-api answers every request
// with a 403 carrying detail.
func refusingTIDAL(t *testing.T, detail string) *tidal.Client {
	t.Helper()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]string{"detail": detail})
	}))
	t.Cleanup(proxy.Close)
	return tidal.NewClient(tidal.Config{HifiAPIURL: proxy.URL})
}

func serveAuthenticated(t *testing.T, pattern string, handler http.HandlerFunc, target string) *httptest.ResponseRecorder {
	t.Helper()
	sessions := &activitySocketSessions{cookieName: "session", user: &models.User{ID: uuid.New()}}
	router := chi.NewRouter()
	router.Use(middleware.Authenticate(sessions))
	router.Get(pattern, handler)
	r := httptest.NewRequest(http.MethodGet, target, nil)
	r.AddCookie(&http.Cookie{Name: "session", Value: "test"})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	return w
}

func TestTIDALRefusalsReachTheClientWithTIDALsReason(t *testing.T) {
	const reason = "Not available in your region"
	client := refusingTIDAL(t, reason)
	tracks := &Tracks{TIDAL: client}
	browse := &TIDAL{TIDAL: client}
	for _, tc := range []struct {
		name, pattern, target, want string
		handler                     http.HandlerFunc
	}{
		{"stream", "/api/tracks/{id}/stream", "/api/tracks/tidal:123/stream", "TIDAL refused to stream this track: " + reason, tracks.Stream},
		{"download", "/api/tracks/{id}/stream", "/api/tracks/tidal:123/stream?download=1", "TIDAL refused to stream this track: " + reason, tracks.Stream},
		{"album", "/api/tidal/albums/{id}", "/api/tidal/albums/456", "TIDAL refused this album: " + reason, browse.Album},
		{"artist", "/api/tidal/artists/{id}", "/api/tidal/artists/789", "TIDAL refused this artist: " + reason, browse.Artist},
		{"track info", "/api/tidal/tracks/{id}", "/api/tidal/tracks/321", "TIDAL refused this track: " + reason, browse.Track},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := serveAuthenticated(t, tc.pattern, tc.handler, tc.target)
			if w.Code != http.StatusBadGateway || w.Body.String() != tc.want+"\n" {
				t.Fatalf("status=%d body=%q, want 502 %q", w.Code, w.Body.String(), tc.want)
			}
		})
	}
}

func TestTIDALRefusalWithoutAReason(t *testing.T) {
	tracks := &Tracks{TIDAL: refusingTIDAL(t, "Upstream API error")}
	w := serveAuthenticated(t, "/api/tracks/{id}/stream", tracks.Stream, "/api/tracks/tidal:123/stream")
	if w.Code != http.StatusBadGateway || w.Body.String() != "TIDAL refused to stream this track.\n" {
		t.Fatalf("status=%d body=%q", w.Code, w.Body.String())
	}
}

func TestSearchWarnsWithTIDALsRefusal(t *testing.T) {
	store := &searchTestLibrary{viewer: uuid.New()}
	h := &Search{Library: store, TIDAL: refusingTIDAL(t, "Client is blocked")}
	w := runSearch(t, h, store.viewer, "q=hello&type=all&sources=tidal")
	var resp searchResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(w.Body.String())
	}
	sort.Strings(resp.Warnings)
	want := []string{
		"TIDAL refused the album search: Client is blocked",
		"TIDAL refused the artist search: Client is blocked",
		"TIDAL refused the track search: Client is blocked",
	}
	if len(resp.Warnings) != len(want) {
		t.Fatalf("warnings = %q, want %q", resp.Warnings, want)
	}
	for i := range want {
		if resp.Warnings[i] != want[i] {
			t.Fatalf("warnings = %q, want %q", resp.Warnings, want)
		}
	}
}

func TestAlbumRefusedPartWayIsARefusal(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("offset") != "0" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"detail":"Not available in your region"}`))
			return
		}
		// The first page lists one of the release's two tracks.
		_, _ = w.Write([]byte(`{"data":{"id":456,"title":"Album","numberOfTracks":2,"items":[{"type":"track","item":{"id":1,"title":"One"}}]}}`))
	}))
	defer proxy.Close()
	browse := &TIDAL{TIDAL: tidal.NewClient(tidal.Config{HifiAPIURL: proxy.URL})}
	w := serveAuthenticated(t, "/api/tidal/albums/{id}", browse.Album, "/api/tidal/albums/456")
	want := "TIDAL refused this album: Not available in your region\n"
	if w.Code != http.StatusBadGateway || w.Body.String() != want {
		t.Fatalf("status=%d body=%q, want 502 %q", w.Code, w.Body.String(), want)
	}
}
