package tidal

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRewriteHLSPlaylist(t *testing.T) {
	playlist := strings.Join([]string{
		"#EXTM3U",
		`#EXT-X-KEY:METHOD=AES-128,URI="keys/1.key"`,
		"#EXTINF:4.0,",
		"segment-1.mp4",
		"#EXT-X-STREAM-INF:BANDWIDTH=1000",
		"https://im-fa.manifest.tidal.com/nested/playlist.m3u8?token=abc",
		"",
	}, "\n")

	got := rewriteHLSPlaylist(playlist, "https://im-fa.manifest.tidal.com/root/master.m3u8?token=abc", func(raw string) string {
		return "/proxy?u=" + raw
	})

	for _, want := range []string{
		`URI="/proxy?u=https://im-fa.manifest.tidal.com/root/keys/1.key"`,
		"/proxy?u=https://im-fa.manifest.tidal.com/root/segment-1.mp4",
		"/proxy?u=https://im-fa.manifest.tidal.com/nested/playlist.m3u8?token=abc",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("rewritten playlist missing %q:\n%s", want, got)
		}
	}
}

func TestHifiQualityAttempts(t *testing.T) {
	tests := []struct {
		quality string
		want    []string
	}{
		{quality: "LOSSLESS", want: []string{"LOSSLESS", "HIGH", "LOW"}},
		{quality: "MAX", want: []string{"HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"}},
		{quality: "HIGH", want: []string{"HIGH", "LOW"}},
		{quality: "LOW", want: []string{"LOW"}},
	}
	for _, tt := range tests {
		t.Run(tt.quality, func(t *testing.T) {
			got := hifiQualityAttempts(tt.quality)
			if strings.Join(got, ",") != strings.Join(tt.want, ",") {
				t.Fatalf("hifiQualityAttempts(%q) = %v, want %v", tt.quality, got, tt.want)
			}
		})
	}
}

func TestHifiManifestFormats(t *testing.T) {
	tests := []struct {
		quality string
		want    []string
	}{
		{quality: "LOSSLESS", want: []string{"FLAC", "AACLC", "HEAACV1"}},
		{quality: "MAX", want: []string{"FLAC_HIRES", "FLAC", "AACLC", "HEAACV1"}},
		{quality: "HIGH", want: []string{"AACLC", "HEAACV1"}},
		{quality: "LOW", want: []string{"HEAACV1"}},
	}
	for _, tt := range tests {
		t.Run(tt.quality, func(t *testing.T) {
			got := hifiManifestFormats(tt.quality)
			if strings.Join(got, ",") != strings.Join(tt.want, ",") {
				t.Fatalf("hifiManifestFormats(%q) = %v, want %v", tt.quality, got, tt.want)
			}
		})
	}
}

func TestHifiTrackManifestReturnsHLSURI(t *testing.T) {
	wantURL := "https://im-fa.manifest.tidal.com/1/manifests/test.m3u8?token=abc"
	var gotManifestType string
	var gotFormats []string
	trackCalled := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/trackManifests/":
			if r.URL.Query().Get("id") != "123" {
				t.Fatalf("id = %q, want 123", r.URL.Query().Get("id"))
			}
			gotManifestType = r.URL.Query().Get("manifestType")
			gotFormats = r.URL.Query()["formats"]
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"2.10","data":{"data":{"attributes":{"trackPresentation":"FULL","uri":"` + wantURL + `","formats":["FLAC"]}}}}`))
		case "/track/":
			trackCalled = true
			http.Error(w, "should not fallback", http.StatusInternalServerError)
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL, Quality: "LOSSLESS"})
	got, err := c.StreamURL(context.Background(), "123")
	if err != nil {
		t.Fatalf("StreamURL returned error: %v", err)
	}
	if got != wantURL {
		t.Fatalf("StreamURL = %q, want %q", got, wantURL)
	}
	if gotManifestType != "HLS" {
		t.Fatalf("manifestType = %q, want HLS", gotManifestType)
	}
	if strings.Join(gotFormats, ",") != "FLAC,AACLC,HEAACV1" {
		t.Fatalf("formats = %v", gotFormats)
	}
	if trackCalled {
		t.Fatal("/track/ fallback was called")
	}
}

func TestHifiResolverExtractsStreamURL(t *testing.T) {
	wantURL := "https://lgf.audio.tidal.com/mediatracks/test/0.flac?token=abc"
	manifest := base64.StdEncoding.EncodeToString([]byte(`{"urls":["` + wantURL + `"]}`))
	var gotQuality string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/trackManifests/" {
			http.Error(w, "hls unavailable", http.StatusBadGateway)
			return
		}
		if r.URL.Path != "/track/" {
			t.Fatalf("path = %q, want /track/", r.URL.Path)
		}
		if r.URL.Query().Get("id") != "123" {
			t.Fatalf("id = %q, want 123", r.URL.Query().Get("id"))
		}
		gotQuality = r.URL.Query().Get("quality")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"2.10","data":{"assetPresentation":"FULL","audioQuality":"LOSSLESS","manifestMimeType":"application/vnd.tidal.bts","manifest":"` + manifest + `"}}`))
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL, Quality: "LOSSLESS"})
	got, err := c.StreamURL(context.Background(), "123")
	if err != nil {
		t.Fatalf("StreamURL returned error: %v", err)
	}
	if got != wantURL {
		t.Fatalf("StreamURL = %q, want %q", got, wantURL)
	}
	if gotQuality != "LOSSLESS" {
		t.Fatalf("quality = %q, want LOSSLESS", gotQuality)
	}
}

func TestHifiSearchTracks(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search/" {
			t.Fatalf("path = %q, want /search/", r.URL.Path)
		}
		gotQuery = r.URL.Query().Get("s")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"2.10","data":{"items":[{"id":487833029,"title":"Nakamura","duration":185,"trackNumber":1,"volumeNumber":1,"artist":{"name":"Lil Uzi Vert"},"artists":[{"name":"Lil Uzi Vert"}],"album":{"id":123,"title":"Eternal Atake 2","cover":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}}]}}`))
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL})
	tracks, err := c.SearchTracks(context.Background(), "Nakamura", 25, 0)
	if err != nil {
		t.Fatalf("SearchTracks returned error: %v", err)
	}
	if gotQuery != "Nakamura" {
		t.Fatalf("query = %q, want Nakamura", gotQuery)
	}
	if len(tracks) != 1 {
		t.Fatalf("len(tracks) = %d, want 1", len(tracks))
	}
	if tracks[0].ID != "487833029" || tracks[0].Title != "Nakamura" || tracks[0].Artists[0] != "Lil Uzi Vert" {
		t.Fatalf("unexpected track: %+v", tracks[0])
	}
}

func TestHifiStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			t.Fatalf("path = %q, want /", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"2.10","Repo":"https://github.com/binimum/hifi-api"}`))
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL, CountryCode: "PL", Quality: "LOSSLESS"})
	status, err := c.Status(context.Background())
	if err != nil {
		t.Fatalf("Status returned error: %v", err)
	}
	if !status.Connected {
		t.Fatal("status.Connected = false, want true")
	}
	if status.Version != "2.10" || status.CountryCode != "PL" || status.Quality != "LOSSLESS" {
		t.Fatalf("unexpected status: %+v", status)
	}
}
