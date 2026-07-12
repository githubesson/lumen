package handlers

import (
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Lyrics proxies requests to lrclib.net, a public lyrics API that supports
// both plain text and synced (LRC) lyrics. It supports two modes:
//   - Search: ?q=query returns a list of matching tracks
//   - Get: ?track_name=&artist_name=&album_name=&duration= returns lyrics for a specific track
type Lyrics struct {
	// BaseURL for the lrclib API. Defaults to https://lrclib.net if empty.
	BaseURL string
}

func (h *Lyrics) baseURL() string {
	if h.BaseURL != "" {
		return h.BaseURL
	}
	return "https://lrclib.net"
}

// isSearch returns true if the query contains "q" but not the specific track fields.
func (h *Lyrics) isSearch(q url.Values) bool {
	return q.Has("q") && !q.Has("track_name") && !q.Has("duration")
}

// Handle proxies the request to lrclib.net. It mirrors the query parameters
// and forwards the response as-is. Rate limiting is handled by the middleware.
func (h *Lyrics) Handle(w http.ResponseWriter, r *http.Request) {
	// Build target URL
	base := h.baseURL()
	endpoint := "/api/search"
	if !h.isSearch(r.URL.Query()) {
		endpoint = "/api/get"
	}
	target := base + endpoint

	// Build query string - only forward allowed parameters
	allowed := []string{"track_name", "artist_name", "album_name", "duration", "q"}
	values := url.Values{}
	for _, key := range allowed {
		if v := r.URL.Query().Get(key); v != "" {
			values.Set(key, v)
		}
	}
	if len(values) > 0 {
		target += "?" + values.Encode()
	}

	// Create and send request
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		slog.Error("lyrics proxy: create request failed", "err", err)
		http.Error(w, "proxy_error", http.StatusBadGateway)
		return
	}

	// Set headers
	req.Header.Set("User-Agent", "wuby.run (lrclib-proxy)")
	req.Header.Set("Accept", "application/json")

	client := &http.Client{
		Timeout: 10 * time.Second,
	}

	resp, err := client.Do(req)
	if err != nil {
		slog.Error("lyrics proxy: request failed", "err", err)
		http.Error(w, "proxy_error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	for key, vals := range resp.Header {
		// Skip certain headers
		if strings.EqualFold(key, "content-encoding") ||
			strings.EqualFold(key, "transfer-encoding") ||
			strings.EqualFold(key, "connection") {
			continue
		}
		for _, val := range vals {
			w.Header().Add(key, val)
		}
	}

	// Copy status code
	w.WriteHeader(resp.StatusCode)

	// Copy body
	written, err := io.Copy(w, resp.Body)
	if err != nil {
		// Client may have disconnected, log but don't send another response
		slog.Warn("lyrics proxy: response copy failed", "err", err, "written", written)
		return
	}

	slog.Debug("lyrics proxy: request completed", "status", resp.StatusCode, "bytes", written)
}
