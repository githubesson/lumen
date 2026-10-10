package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/githubesson/lumen/internal/auth"
)

// A browser request from another origin must not reach a mutating handler,
// while same-origin and non-browser requests (the mobile app) still do.
func TestRouterRefusesCrossOriginWrites(t *testing.T) {
	h := NewRouter(Deps{Sessions: auth.NewSessionStore(nil, "mlsession", true, time.Hour)})
	cases := []struct {
		name    string
		method  string
		headers map[string]string
		want    int
	}{
		// RequireUser answers 401 once the request gets past the check.
		{"same origin", http.MethodPost, map[string]string{"Sec-Fetch-Site": "same-origin"}, http.StatusUnauthorized},
		{"non-browser client", http.MethodPost, nil, http.StatusUnauthorized},
		{"cross site", http.MethodPost, map[string]string{"Sec-Fetch-Site": "cross-site"}, http.StatusForbidden},
		{"sibling subdomain", http.MethodPost, map[string]string{"Sec-Fetch-Site": "same-site"}, http.StatusForbidden},
		{"foreign Origin without Sec-Fetch-Site", http.MethodPost, map[string]string{"Origin": "https://evil.example"}, http.StatusForbidden},
		{"cross-site read", http.MethodGet, map[string]string{"Sec-Fetch-Site": "cross-site"}, http.StatusUnauthorized},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := "/api/playlists"
			if c.method == http.MethodGet {
				path = "/api/auth/me"
			}
			req := httptest.NewRequest(c.method, "https://music.example.com"+path, nil)
			for k, v := range c.headers {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != c.want {
				t.Fatalf("status = %d, want %d", rec.Code, c.want)
			}
		})
	}
}
