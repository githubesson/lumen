package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/models"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func TestTIDALTrackResponse(t *testing.T) {
	const track = `{"id":123,"title":"Song","copyright":"(P) 2023 Label","audioModes":["STEREO"],` +
		`"mediaMetadata":{"tags":["LOSSLESS"]},"artists":[{"name":"Main","type":"MAIN"},{"name":"Guest","type":"FEATURED"}]}`
	for _, tc := range []struct {
		name, id, body string
		proxyStatus    int
		status         int
		want           *tidalTrackResp
	}{
		{"details", "123", `{"track":` + track + `,"album":{"releaseDate":"2023-03-17"},"credits":[{"type":"Producer","names":["Maker"]}],"failed_sections":[]}`, 200, 200, &tidalTrackResp{
			ID:          "123",
			Artists:     []tidalTrackArtistResp{{Name: "Main", Role: "main"}, {Name: "Guest", Role: "featured"}},
			ReleaseDate: "2023-03-17",
			Copyright:   "(P) 2023 Label",
			Quality:     "LOSSLESS",
			Channels:    2,
			Credits:     []tidalTrackCreditResp{{Role: "Producer", Names: []string{"Maker"}}},
		}},
		{"credits failed", "123", `{"track":{"id":123,"title":"Song"},"album":null,"credits":[],"failed_sections":["credits"]}`, 200, 200, &tidalTrackResp{
			ID:            "123",
			Artists:       []tidalTrackArtistResp{},
			Credits:       []tidalTrackCreditResp{},
			CreditsFailed: true,
		}},
		{"upstream failure", "123", `{"detail":"private upstream failure"}`, 502, 502, nil},
		{"invalid id", "12a", "", 0, 400, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.proxyStatus == 0 || r.URL.Path != "/lumen/track" || r.URL.Query().Get("id") != tc.id {
					t.Errorf("unexpected request %s", r.URL)
				}
				w.WriteHeader(tc.proxyStatus)
				_, _ = fmt.Fprint(w, tc.body)
			}))
			defer proxy.Close()
			h := &TIDAL{TIDAL: tidal.NewClient(tidal.Config{HifiAPIURL: proxy.URL})}
			sessions := &activitySocketSessions{cookieName: "session", user: &models.User{ID: uuid.New()}}
			router := chi.NewRouter()
			router.Use(middleware.Authenticate(sessions))
			router.Get("/api/tidal/tracks/{id}", h.Track)
			r := httptest.NewRequest(http.MethodGet, "/api/tidal/tracks/"+tc.id, nil)
			r.AddCookie(&http.Cookie{Name: "session", Value: "test"})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body)
			}
			if tc.want == nil {
				return
			}
			var got tidalTrackResp
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(&got, tc.want) {
				t.Fatalf("got %+v\nwant %+v", got, *tc.want)
			}
		})
	}
}

func TestTIDALTrackNeedsTheProxy(t *testing.T) {
	sessions := &activitySocketSessions{cookieName: "session", user: &models.User{ID: uuid.New()}}
	router := chi.NewRouter()
	router.Use(middleware.Authenticate(sessions))
	router.Get("/api/tidal/tracks/{id}", (&TIDAL{}).Track)
	r := httptest.NewRequest(http.MethodGet, "/api/tidal/tracks/123", nil)
	r.AddCookie(&http.Cookie{Name: "session", Value: "test"})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d", w.Code)
	}
}
