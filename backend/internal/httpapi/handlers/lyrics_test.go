package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGeniusTLSLiveChain(t *testing.T) {
	if os.Getenv("LUMEN_TEST_GENIUS_LIVE") == "" {
		t.Skip("set LUMEN_TEST_GENIUS_LIVE=1 to exercise Genius over the network")
	}

	handler := &Lyrics{GeniusProxyURL: os.Getenv("GENIUS_PROXY_URL")}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	track := os.Getenv("LUMEN_TEST_GENIUS_TRACK")
	if track == "" {
		track = "Creep"
	}
	artist := os.Getenv("LUMEN_TEST_GENIUS_ARTIST")
	if artist == "" {
		artist = "Radiohead"
	}
	result := handler.fetchGenius(ctx, url.Values{
		"track_name":  {track},
		"artist_name": {artist},
	})
	if result.err != nil {
		t.Fatal(result.err)
	}
	var lyrics geniusLyricsResult
	if err := json.Unmarshal(result.body, &lyrics); err != nil {
		t.Fatal(err)
	}
	if lyrics.TrackName == "" || lyrics.ArtistName == "" || lyrics.PlainLyrics == "" {
		t.Fatalf("incomplete Genius result: %#v", lyrics)
	}
	if strings.Contains(lyrics.PlainLyrics, "Contributors") {
		t.Fatalf("Genius page chrome leaked into lyrics: %q", lyrics.PlainLyrics[:min(len(lyrics.PlainLyrics), 120)])
	}
	t.Logf("lyrics preview: %q", lyrics.PlainLyrics[:min(len(lyrics.PlainLyrics), 160)])
}

func TestGeniusSessionRetriesDroppedGET(t *testing.T) {
	t.Parallel()

	var attempts atomic.Int32
	client := &http.Client{Transport: lyricsRoundTripFunc(func(*http.Request) (*http.Response, error) {
		if attempts.Add(1) == 1 {
			return nil, io.EOF
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"response":{"sections":[]}}`)),
			Header:     make(http.Header),
		}, nil
	})}
	session := &geniusSession{standard: client}
	var response geniusSearchResponse
	if err := session.getJSON(context.Background(), "https://genius.test/search", &response); err != nil {
		t.Fatal(err)
	}
	if got := attempts.Load(); got != 2 {
		t.Fatalf("attempts = %d, want 2", got)
	}
}

func TestLyricsReturnsFastestUsableProvider(t *testing.T) {
	t.Parallel()

	var lrclibCanceled atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/get":
			select {
			case <-r.Context().Done():
				lrclibCanceled.Store(true)
			case <-time.After(time.Second):
				t.Error("LRCLIB request was not canceled")
			}
		case "/api/search/multi":
			writeGeniusSearch(t, w, serverURL(r)+"/song")
		case "/song":
			_, _ = w.Write([]byte(`<div data-lyrics-container="true"><div data-exclude-from-selection="true">3 ContributorsEverywhere Lyrics</div>[Verse]<br>Fast lyrics</div>`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	handler := &Lyrics{BaseURL: server.URL, GeniusBaseURL: server.URL, Client: server.Client()}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/lyrics?track_name=Fast&artist_name=Artist", nil)
	handler.Handle(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("X-Lyrics-Provider"); got != "genius" {
		t.Fatalf("provider = %q, want genius", got)
	}
	var result geniusLyricsResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.PlainLyrics != "[Verse]\nFast lyrics" {
		t.Fatalf("plainLyrics = %q", result.PlainLyrics)
	}

	deadline := time.Now().Add(time.Second)
	for !lrclibCanceled.Load() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !lrclibCanceled.Load() {
		t.Fatal("losing LRCLIB request was not canceled")
	}
}

func TestLyricsWaitsForOtherProviderAfterFastMiss(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/get":
			time.Sleep(30 * time.Millisecond)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":1,"trackName":"Fallback","artistName":"Artist","plainLyrics":"Found"}`))
		case "/api/search/multi":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"response":{"sections":[]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	handler := &Lyrics{BaseURL: server.URL, GeniusBaseURL: server.URL, Client: server.Client()}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/lyrics?track_name=Fallback&artist_name=Artist", nil)
	handler.Handle(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("X-Lyrics-Provider"); got != "lrclib" {
		t.Fatalf("provider = %q, want lrclib", got)
	}
}

func TestLyricsGeniusSearchReturnsArray(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/search":
			_, _ = w.Write([]byte(`[]`))
		case "/api/search/multi":
			writeGeniusSearch(t, w, serverURL(r)+"/song")
		case "/song":
			_, _ = w.Write([]byte(`<div data-lyrics-container="true">Search result</div>`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	handler := &Lyrics{BaseURL: server.URL, GeniusBaseURL: server.URL, Client: server.Client()}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/lyrics?q=Song+Artist", nil)
	handler.Handle(recorder, request)

	var results []geniusLyricsResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &results); err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].PlainLyrics != "Search result" {
		t.Fatalf("results = %#v", results)
	}
}

func TestLyricsReturnsNotFoundWhenBothProvidersMiss(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/search/multi" {
			_, _ = w.Write([]byte(`{"response":{"sections":[]}}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	handler := &Lyrics{BaseURL: server.URL, GeniusBaseURL: server.URL, Client: server.Client()}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/lyrics?track_name=Missing", nil)
	handler.Handle(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
}

func writeGeniusSearch(t *testing.T, w http.ResponseWriter, songURL string) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]any{
		"response": map[string]any{
			"sections": []any{map[string]any{
				"hits": []any{map[string]any{
					"type": "song",
					"result": map[string]any{
						"id":           42,
						"title":        "Fast",
						"artist_names": "Artist",
						"url":          songURL,
					},
				}},
			}},
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func serverURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

type lyricsRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn lyricsRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}
