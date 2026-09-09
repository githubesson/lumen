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
	}{
		{"total failure", 502, `{"detail":"private upstream failure"}`, "", 0},
		{"partial failure", 200, `{"albums":{"items":[{"id":456,"title":"Release"}]},"tracks":[],"failed_sections":["singles"]}`, "Couldn't load singles and EPs.", 1},
		{"incomplete empty", 200, `{"albums":{"items":[]},"tracks":[],"failed_sections":["albums"]}`, "Couldn't load albums.", 0},
		{"confirmed empty", 200, `{"albums":{"items":[]},"tracks":[],"failed_sections":[]}`, "", 0},
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
				Albums   []searchAlbumResp   `json:"albums"`
				Tracks   []trackListItemResp `json:"tracks"`
				Warnings []string            `json:"warnings"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Albums == nil || result.Tracks == nil || len(result.Albums) != tc.albums {
				t.Fatalf("bad data: %+v", result)
			}
			if tc.warning == "" && len(result.Warnings) != 0 || tc.warning != "" && (len(result.Warnings) != 1 || result.Warnings[0] != tc.warning) {
				t.Fatalf("bad warnings: %+v", result.Warnings)
			}
		})
	}
}
