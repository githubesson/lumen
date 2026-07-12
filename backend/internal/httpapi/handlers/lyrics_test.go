package handlers

import (
	"context"
	"encoding/json"
	"errors"
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

func TestLRCLibLiveSelection(t *testing.T) {
	if os.Getenv("LUMEN_TEST_LRCLIB_LIVE") == "" {
		t.Skip("set LUMEN_TEST_LRCLIB_LIVE=1 to exercise LRCLIB over the network")
	}

	handler := &Lyrics{}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	track := getenvDefault("LUMEN_TEST_LRCLIB_TRACK", "Ran To Atlanta")
	artist := getenvDefault("LUMEN_TEST_LRCLIB_ARTIST", "Drake")
	album := getenvDefault("LUMEN_TEST_LRCLIB_ALBUM", "ICEMAN")
	duration := getenvDefault("LUMEN_TEST_LRCLIB_DURATION", "247")
	result := handler.fetchLRCLib(ctx, url.Values{
		"track_name":  {track},
		"artist_name": {artist},
		"album_name":  {album},
		"duration":    {duration},
	})
	if result.err != nil {
		t.Fatal(result.err)
	}
	var selected struct {
		ID           int64   `json:"id"`
		TrackName    string  `json:"trackName"`
		ArtistName   string  `json:"artistName"`
		SyncedLyrics *string `json:"syncedLyrics"`
	}
	if err := json.Unmarshal(result.body, &selected); err != nil {
		t.Fatal(err)
	}
	if !nonEmpty(selected.SyncedLyrics) || !lrcTimestampPattern.MatchString(*selected.SyncedLyrics) {
		t.Fatalf("selected non-timestamped record: %#v", selected)
	}
	t.Logf("selected LRCLIB id=%d track=%q artist=%q", selected.ID, selected.TrackName, selected.ArtistName)
}

func getenvDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
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

func TestLRCLibRetriesTransientFailuresThreeTimes(t *testing.T) {
	t.Parallel()

	var attempts atomic.Int32
	client := &http.Client{Transport: lyricsRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Query().Has("album_name") {
			t.Error("LRCLIB search must not filter candidates by album")
		}
		if attempts.Add(1) < 3 {
			return nil, io.EOF
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body: io.NopCloser(strings.NewReader(
				`[{"id":9,"trackName":"Song","artistName":"Artist","plainLyrics":"Found"}]`,
			)),
			Header: make(http.Header),
		}, nil
	})}
	handler := &Lyrics{Client: client}
	result := handler.fetchLRCLib(context.Background(), url.Values{
		"track_name":  {"Song"},
		"artist_name": {"Artist"},
		"album_name":  {"Different Deluxe Edition"},
	})
	if result.err != nil {
		t.Fatal(result.err)
	}
	if got := attempts.Load(); got != 3 {
		t.Fatalf("attempts = %d, want 3", got)
	}
}

func TestLRCLibDoesNotRetryDefinitiveNotFound(t *testing.T) {
	t.Parallel()

	var attempts atomic.Int32
	client := &http.Client{Transport: lyricsRoundTripFunc(func(*http.Request) (*http.Response, error) {
		attempts.Add(1)
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Body:       io.NopCloser(strings.NewReader(`{"message":"not found"}`)),
			Header:     make(http.Header),
		}, nil
	})}
	handler := &Lyrics{Client: client}
	result := handler.fetchLRCLib(context.Background(), url.Values{"track_name": {"Missing"}})
	if !errors.Is(result.err, errLyricsNotFound) {
		t.Fatalf("error = %v, want lyrics not found", result.err)
	}
	if got := attempts.Load(); got != 1 {
		t.Fatalf("attempts = %d, want 1", got)
	}
}

func TestCleanLyricsSearchTerm(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"PINK (v1) 💗":         "PINK",
		"Everywhere [V 12] 🚀": "Everywhere",
		"Kosmita ✨ (Live)":    "Kosmita (Live)",
	}
	for input, want := range tests {
		if got := cleanLyricsSearchTerm(input); got != want {
			t.Errorf("cleanLyricsSearchTerm(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestComparableLyricsTitleOmitsFeaturedSuffix(t *testing.T) {
	t.Parallel()

	want := "ran to atlanta"
	for _, title := range []string{
		"Ran To Atlanta",
		"Ran To Atlanta (feat. Future & Molly Santana)",
		"Ran To Atlanta [ft. Future]",
		"Ran To Atlanta (feat. Future",
	} {
		if got := comparableLyricsTitle(title); got != want {
			t.Errorf("comparableLyricsTitle(%q) = %q, want %q", title, got, want)
		}
	}
}

func TestGeniusTitleMatchAllowsAliasesButPrefersExact(t *testing.T) {
	t.Parallel()

	if score := geniusTitleMatchScore("Herbo Flow (Rich Off Rap)", "Herbo Flow"); score != 100 {
		t.Fatalf("alias score = %d, want 100", score)
	}
	if score := geniusTitleMatchScore("Rental (Cha-Ching)", "Rental"); score != 100 {
		t.Fatalf("alias score = %d, want 100", score)
	}
	if score := geniusTitleMatchScore("Rental", "Rental"); score != 200 {
		t.Fatalf("exact score = %d, want 200", score)
	}
	if score := geniusTitleMatchScore("Rental Car", "Rental"); score != 0 {
		t.Fatalf("unrelated score = %d, want 0", score)
	}
}

func TestSelectLRCLibCandidatePrefersTimestampedSyncedLyrics(t *testing.T) {
	t.Parallel()

	body := []byte(`[
		{"id":1,"trackName":"Song","artistName":"Artist","duration":200,"plainLyrics":"Plain"},
		{"id":2,"trackName":"Song","artistName":"Artist","duration":200,"syncedLyrics":"Synced but no timestamps"},
		{"id":3,"trackName":"Song","artistName":"Artist","duration":260,"syncedLyrics":"[00:01.00] Timed but wrong duration"},
		{"id":4,"trackName":"Song (feat. Guest & Another Artist)","artistName":"Artist - Guest","duration":201,"syncedLyrics":"[00:01.00] First\n[00:03.20] Second"},
		{"id":5,"trackName":"Different Song","artistName":"Artist","duration":200,"syncedLyrics":"[00:01.00] Wrong track"}
	]`)
	selected, ok := selectLRCLibCandidate(body, url.Values{
		"track_name":  {"Song"},
		"artist_name": {"Artist"},
		"duration":    {"200"},
	})
	if !ok {
		t.Fatal("expected an LRCLIB candidate")
	}
	var result struct {
		ID int `json:"id"`
	}
	if err := json.Unmarshal(selected, &result); err != nil {
		t.Fatal(err)
	}
	if result.ID != 4 {
		t.Fatalf("selected id = %d, want timestamped duration match 4", result.ID)
	}
}

func TestLyricsSkipsWrongGeniusSongAndUsesNormalizedQuery(t *testing.T) {
	t.Parallel()

	var wrongPageRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/search":
			http.NotFound(w, r)
		case "/api/search/multi":
			if got := r.URL.Query().Get("q"); got != "Right Song Artist" {
				t.Errorf("Genius query = %q, want normalized query", got)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"response": map[string]any{"sections": []any{map[string]any{"hits": []any{
					map[string]any{"type": "song", "result": map[string]any{
						"id": 1, "title": "Wrong Song", "artist_names": "Artist", "url": serverURL(r) + "/wrong",
					}},
					map[string]any{"type": "song", "result": map[string]any{
						"id": 2, "title": "Right Song", "artist_names": "Artist", "url": serverURL(r) + "/right",
					}},
				}}}},
			})
		case "/wrong":
			wrongPageRequests.Add(1)
			_, _ = w.Write([]byte(`<div data-lyrics-container="true">Wrong lyrics</div>`))
		case "/right":
			_, _ = w.Write([]byte(`<div data-lyrics-container="true">Right lyrics</div>`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	handler := &Lyrics{BaseURL: server.URL, GeniusBaseURL: server.URL, Client: server.Client()}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/lyrics?track_name=Right+Song+%28v1%29+%F0%9F%9A%80&artist_name=Artist", nil)
	handler.Handle(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	if wrongPageRequests.Load() != 0 {
		t.Fatal("scraped a Genius result whose metadata did not match")
	}
	var result geniusLyricsResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.PlainLyrics != "Right lyrics" || result.ID != 2 {
		t.Fatalf("result = %#v", result)
	}
}

func TestLyricsWaitsForLRCLibBeforeUsingGenius(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/search":
			time.Sleep(50 * time.Millisecond)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"id":7,"trackName":"Fast","artistName":"Artist","syncedLyrics":"[00:01.00]Synced lyrics"}]`))
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
	if got := recorder.Header().Get("X-Lyrics-Provider"); got != "lrclib" {
		t.Fatalf("provider = %q, want lrclib", got)
	}
	if !strings.Contains(recorder.Body.String(), "Synced lyrics") {
		t.Fatalf("body = %s, want LRCLIB synced lyrics", recorder.Body.String())
	}
}

func TestLyricsWaitsForOtherProviderAfterFastMiss(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/search":
			time.Sleep(30 * time.Millisecond)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"id":1,"trackName":"Fallback","artistName":"Artist","plainLyrics":"Found"}]`))
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
