package tidal

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

func TestHifiForbiddenIsARefusalWithTIDALsReason(t *testing.T) {
	for _, tc := range []struct {
		name, body, reason string
	}{
		{"reason", `{"detail":"Not available\n in your\tregion"}`, "Not available in your region"},
		{"upstream's fixed detail", `{"detail":"Upstream API error"}`, ""},
		{"not json", `forbidden`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			_, err := NewClient(Config{HifiAPIURL: srv.URL}).Track(context.Background(), "1")
			var refused *RefusedError
			if !errors.Is(err, ErrRefused) || !errors.As(err, &refused) {
				t.Fatalf("err = %v, want a refusal", err)
			}
			if refused.Reason != tc.reason {
				t.Fatalf("reason = %q, want %q", refused.Reason, tc.reason)
			}
		})
	}
}

func TestOtherHifiFailuresAreNotRefusals(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"detail":"Upstream timeout"}`, http.StatusTooManyRequests)
	}))
	defer srv.Close()
	_, err := NewClient(Config{HifiAPIURL: srv.URL}).Track(context.Background(), "1")
	if err == nil || errors.Is(err, ErrRefused) {
		t.Fatalf("err = %v, want a non-refusal error", err)
	}
}

func TestRefusalReasonIsCappedPrintableText(t *testing.T) {
	reason := refusalReason([]byte(`{"detail":"` + strings.Repeat("é", 300) + `\u0000\u001b[31m"}`))
	if n := utf8.RuneCountInString(reason); n != maxRefusalReason+1 || !strings.HasSuffix(reason, "…") {
		t.Fatalf("reason has %d runes (%q), want %d plus an ellipsis", n, reason, maxRefusalReason)
	}
	if got := refusalReason([]byte(`{"detail":"Gone\u0000\u001b[31m now"}`)); got != "Gone [31m now" {
		t.Fatalf("reason = %q", got)
	}
}

func TestStreamRefusalSkipsLowerQualitiesAndIsRemembered(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"detail":"Not available in your region"}`))
	}))
	defer srv.Close()
	c := NewClient(Config{HifiAPIURL: srv.URL, Quality: "LOSSLESS"})
	for attempt := 0; attempt < 3; attempt++ {
		_, err := c.StreamURL(context.Background(), "123")
		var refused *RefusedError
		if !errors.As(err, &refused) || refused.Reason != "Not available in your region" {
			t.Fatalf("attempt %d: err = %v, want the refusal", attempt, err)
		}
	}
	// The manifest, then playbackinfo once rather than at every quality;
	// later attempts are answered from the cache.
	if got := calls.Load(); got != 2 {
		t.Fatalf("hifi-api calls = %d, want 2", got)
	}
}

// expiringMediaServer is hifiMediaServer whose manifest hands out a new
// playlist URL on every resolution; the media host refuses the URLs in
// refused.
func expiringMediaServer(t *testing.T, refused func(version int) bool) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var resolutions atomic.Int32
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/trackManifests/":
			version := resolutions.Add(1)
			mediaURL := srv.URL + "/media/playlist.m3u8?v=" + strconv.Itoa(int(version))
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"data":{"attributes":{"trackPresentation":"FULL","uri":"` + mediaURL + `"}}}}`))
		case "/media/playlist.m3u8":
			version, _ := strconv.Atoi(r.URL.Query().Get("v"))
			if refused(version) {
				http.Error(w, "<Error>AccessDenied</Error>", http.StatusForbidden)
				return
			}
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte("#EXTM3U\n#EXTINF:10.0,\nseg1.aac\n#EXT-X-ENDLIST\n"))
		case "/media/seg1.aac":
			_, _ = w.Write([]byte("audio"))
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	return srv, &resolutions
}

func TestCachedStreamURLTheMediaHostRefusesIsResolvedAgain(t *testing.T) {
	streamClient, restore := allowLoopbackMedia()
	defer restore()
	var expired atomic.Bool
	srv, resolutions := expiringMediaServer(t, func(version int) bool { return version == 1 && expired.Load() })
	defer srv.Close()
	c := NewClient(Config{HifiAPIURL: srv.URL})
	c.stream = streamClient
	proxy := func(u string) string { return u }

	for _, step := range []struct {
		name string
		open func() (*http.Response, error)
	}{
		{"playback", func() (*http.Response, error) { return c.HLSResponse(context.Background(), "123", nil, proxy) }},
		{"download", func() (*http.Response, error) { return c.FileResponse(context.Background(), "123", nil) }},
	} {
		t.Run(step.name, func(t *testing.T) {
			expired.Store(false)
			resolutions.Store(0)
			c.streamCache = map[string]cachedStream{}
			for attempt := 0; attempt < 2; attempt++ {
				resp, err := step.open()
				if err != nil {
					t.Fatalf("attempt %d: %v", attempt, err)
				}
				resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("attempt %d: status = %d, want 200", attempt, resp.StatusCode)
				}
				expired.Store(true)
			}
			if got := resolutions.Load(); got != 2 {
				t.Fatalf("resolutions = %d, want 2", got)
			}
		})
	}
}

func TestFreshStreamURLTheMediaHostRefusesIsARefusal(t *testing.T) {
	streamClient, restore := allowLoopbackMedia()
	defer restore()
	srv, resolutions := expiringMediaServer(t, func(int) bool { return true })
	defer srv.Close()
	c := NewClient(Config{HifiAPIURL: srv.URL})
	c.stream = streamClient

	_, err := c.HLSResponse(context.Background(), "123", nil, func(u string) string { return u })
	if !errors.Is(err, ErrRefused) {
		t.Fatalf("playback err = %v, want a refusal", err)
	}
	_, err = c.FileResponse(context.Background(), "123", nil)
	if !errors.Is(err, ErrRefused) {
		t.Fatalf("download err = %v, want a refusal", err)
	}
	// The refusal was remembered, so the download didn't resolve again.
	if got := resolutions.Load(); got != 1 {
		t.Fatalf("resolutions = %d, want 1", got)
	}
}

func TestSegmentRefusedMidDownloadDropsTheCachedStream(t *testing.T) {
	streamClient, restore := allowLoopbackMedia()
	defer restore()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/trackManifests/":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"data":{"attributes":{"trackPresentation":"FULL","uri":"` + srv.URL + `/media/playlist.m3u8"}}}}`))
		case "/media/playlist.m3u8":
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte("#EXTM3U\n#EXTINF:10.0,\nseg1.aac\n#EXT-X-ENDLIST\n"))
		default:
			http.Error(w, "<Error>AccessDenied</Error>", http.StatusForbidden)
		}
	}))
	defer srv.Close()
	c := NewClient(Config{HifiAPIURL: srv.URL})
	c.stream = streamClient

	resp, err := c.FileResponse(context.Background(), "123", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(resp.Body)
	resp.Body.Close()
	if !errors.Is(err, ErrRefused) {
		t.Fatalf("body err = %v, want a refusal", err)
	}
	if _, ok := c.cachedStreamURL(c.cacheKey("123"), time.Now()); ok {
		t.Fatal("the stream with the refused segment is still cached")
	}
}

func TestForgetStreamURLKeepsARememberedRefusal(t *testing.T) {
	c := NewClient(Config{})
	now := time.Now()
	c.storeCachedStream(c.cacheKey("1"), cachedStream{URL: "https://a.tidal.com/1.m3u8"}, streamCacheTTL, now)
	c.storeCachedStream(c.cacheKey("2"), cachedStream{Err: &RefusedError{cause: errors.New("refused")}}, streamRefusalTTL, now)
	c.ForgetStreamURL("1")
	c.ForgetStreamURL("2")
	if _, ok := c.cachedStreamURL(c.cacheKey("1"), now); ok {
		t.Fatal("stream URL was not forgotten")
	}
	if cached, ok := c.cachedStreamURL(c.cacheKey("2"), now); !ok || cached.Err == nil {
		t.Fatal("refusal was forgotten")
	}
}
