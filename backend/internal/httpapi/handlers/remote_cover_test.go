package handlers

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/trackref"
)

func TestAllowedRemoteCoverURLOnlyAllowsTIDALResources(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{
			name: "tidal resources https",
			raw:  "https://resources.tidal.com/images/aa/bb/cc/640x640.jpg",
		},
		{
			name:    "tidal resources http",
			raw:     "http://resources.tidal.com/images/aa/bb/cc/640x640.jpg",
			wantErr: true,
		},
		{
			name:    "other tidal host",
			raw:     "https://listen.tidal.com/images/aa/bb/cc/640x640.jpg",
			wantErr: true,
		},
		{
			name:    "other host",
			raw:     "https://example.com/cover.jpg",
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := allowedRemoteCoverURL(tt.raw)
			if (err != nil) != tt.wantErr {
				t.Fatalf("allowedRemoteCoverURL() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestRemoteCoverURLForSizePrefersStoredCoverURL(t *testing.T) {
	got := remoteCoverURLForSize(library.RemoteCover{
		Source:   trackref.SourceTIDAL,
		CoverID:  "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		CoverURL: "https://resources.tidal.com/images/aa/bb/cc/640x640.jpg",
	}, 1024)
	if got != "https://resources.tidal.com/images/aa/bb/cc/640x640.jpg" {
		t.Fatalf("remoteCoverURLForSize() = %q, want stored cover_url", got)
	}
}

func TestRemoteCoverURLForSizeDerivesKnownTIDALSize(t *testing.T) {
	got := remoteCoverURLForSize(library.RemoteCover{
		Source:  trackref.SourceTIDAL,
		CoverID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	}, 1024)
	if !strings.HasSuffix(got, "/1280x1280.jpg") {
		t.Fatalf("remoteCoverURLForSize() = %q, want hifi-api known size", got)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

// resetCoverCache swaps in a fresh RAM cover cache so tests don't observe
// entries (or inflight warms) left behind by earlier tests.
func resetCoverCache(t *testing.T) {
	t.Helper()
	old := coverCache
	coverCache = newCoverCacheStore()
	t.Cleanup(func() { coverCache = old })
}

// waitForCachedCover polls until the warm goroutine lands the URL in the
// cache, failing the test after a generous deadline.
func waitForCachedCover(t *testing.T, url string) []byte {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, _, ok := coverCache.get(url); ok {
			return data
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("cover %q never landed in the cache", url)
	return nil
}

func TestServeRemoteCoverFetchesTIDALArtworkWithBrowserHeaders(t *testing.T) {
	resetCoverCache(t)
	oldClient := remoteCoverHTTPClient
	defer func() { remoteCoverHTTPClient = oldClient }()

	target := "https://resources.tidal.com/images/aa/bb/cc/640x640.jpg"
	remoteCoverHTTPClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.String() != target {
				t.Fatalf("remote cover request URL = %q, want %q", req.URL.String(), target)
			}
			if got := req.Header.Get("User-Agent"); got == "" {
				t.Fatalf("remote cover request missing User-Agent")
			}
			if got := req.Header.Get("Accept"); !strings.Contains(got, "image/") {
				t.Fatalf("remote cover request Accept = %q, want image accept", got)
			}
			if got := req.Header.Get("Referer"); got != "https://tidal.com/" {
				t.Fatalf("remote cover request Referer = %q, want tidal referer", got)
			}
			return &http.Response{
				StatusCode:    http.StatusOK,
				Status:        "200 OK",
				Header:        http.Header{"Content-Type": []string{"image/jpeg"}},
				Body:          io.NopCloser(strings.NewReader("jpg")),
				ContentLength: 3,
				Request:       req,
			}, nil
		}),
	}
	req := httptest.NewRequest(http.MethodGet, "/api/albums/test/cover", nil)
	rec := httptest.NewRecorder()

	(&Tracks{}).serveRemoteCover(rec, req, target)

	if rec.Code != http.StatusOK {
		t.Fatalf("serveRemoteCover() status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Fatalf("serveRemoteCover() Content-Type = %q, want image/jpeg", got)
	}
	if got := rec.Body.String(); got != "jpg" {
		t.Fatalf("serveRemoteCover() body = %q, want image bytes", got)
	}
}

func TestServeRemoteCoverRedirectsWhenBackendFetchIsBlocked(t *testing.T) {
	resetCoverCache(t)
	oldClient := remoteCoverHTTPClient
	defer func() { remoteCoverHTTPClient = oldClient }()

	target := "https://resources.tidal.com/images/aa/bb/cc/640x640.jpg"
	remoteCoverHTTPClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusForbidden,
				Status:     "403 Forbidden",
				Body:       io.NopCloser(strings.NewReader("forbidden")),
				Request:    req,
			}, nil
		}),
	}
	req := httptest.NewRequest(http.MethodGet, "/api/albums/test/cover", nil)
	rec := httptest.NewRecorder()

	(&Tracks{}).serveRemoteCover(rec, req, target)

	if rec.Code != http.StatusFound {
		t.Fatalf("serveRemoteCover() status = %d, want %d", rec.Code, http.StatusFound)
	}
	if got := rec.Header().Get("Location"); got != target {
		t.Fatalf("serveRemoteCover() Location = %q, want %q", got, target)
	}
}

func TestServeRemoteCoverServesSecondRequestFromRAMCache(t *testing.T) {
	resetCoverCache(t)
	oldClient := remoteCoverHTTPClient
	defer func() { remoteCoverHTTPClient = oldClient }()

	target := "https://resources.tidal.com/images/dd/ee/ff/640x640.jpg"
	fetches := 0
	remoteCoverHTTPClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			fetches++
			return &http.Response{
				StatusCode:    http.StatusOK,
				Status:        "200 OK",
				Header:        http.Header{"Content-Type": []string{"image/jpeg"}},
				Body:          io.NopCloser(strings.NewReader("jpg")),
				ContentLength: 3,
				Request:       req,
			}, nil
		}),
	}

	for i := range 2 {
		req := httptest.NewRequest(http.MethodGet, "/api/covers/remote", nil)
		rec := httptest.NewRecorder()
		(&Tracks{}).serveRemoteCover(rec, req, target)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want %d", i, rec.Code, http.StatusOK)
		}
		if got := rec.Body.String(); got != "jpg" {
			t.Fatalf("request %d: body = %q, want image bytes", i, got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
			t.Fatalf("request %d: Access-Control-Allow-Origin = %q, want *", i, got)
		}
	}
	if fetches != 1 {
		t.Fatalf("upstream fetches = %d, want 1 (second request should hit the RAM cache)", fetches)
	}
}

func TestServeRemoteCoverCoalescesConcurrentFetches(t *testing.T) {
	resetCoverCache(t)
	oldClient := remoteCoverHTTPClient
	defer func() { remoteCoverHTTPClient = oldClient }()

	target := "https://resources.tidal.com/images/co/al/esce/640x640.jpg"
	var fetches atomic.Int32
	remoteCoverHTTPClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			fetches.Add(1)
			// Hold the flight open long enough for every concurrent request
			// to join it instead of starting its own.
			time.Sleep(150 * time.Millisecond)
			return &http.Response{
				StatusCode:    http.StatusOK,
				Status:        "200 OK",
				Header:        http.Header{"Content-Type": []string{"image/jpeg"}},
				Body:          io.NopCloser(strings.NewReader("jpg")),
				ContentLength: 3,
				Request:       req,
			}, nil
		}),
	}

	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "/api/covers/remote", nil)
			rec := httptest.NewRecorder()
			(&Tracks{}).serveRemoteCover(rec, req, target)
			if rec.Code != http.StatusOK {
				t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
			}
			if got := rec.Body.String(); got != "jpg" {
				t.Errorf("body = %q, want image bytes", got)
			}
		}()
	}
	wg.Wait()
	if got := fetches.Load(); got != 1 {
		t.Fatalf("upstream fetches = %d, want 1 (concurrent requests should share one flight)", got)
	}
}

func TestCoverCacheEvictsLeastRecentlyUsedBeyondCap(t *testing.T) {
	c := newCoverCacheStore()
	for i := range coverCacheMaxEntries + 1 {
		c.put("https://resources.tidal.com/images/"+strconv.Itoa(i), []byte("x"), "image/jpeg")
	}
	if _, _, ok := c.get("https://resources.tidal.com/images/0"); ok {
		t.Fatal("oldest entry survived past the cache cap")
	}
	if _, _, ok := c.get("https://resources.tidal.com/images/1"); !ok {
		t.Fatal("second-oldest entry should still be cached")
	}
	if c.order.Len() != coverCacheMaxEntries {
		t.Fatalf("cache size = %d, want %d", c.order.Len(), coverCacheMaxEntries)
	}
}

func TestCoverCacheExpiresEntriesAfterTTL(t *testing.T) {
	c := newCoverCacheStore()
	c.put("k", []byte("x"), "image/jpeg")
	c.entries["k"].Value.(*coverCacheEntry).fetchedAt = time.Now().Add(-coverCacheTTL - time.Second)
	if _, _, ok := c.get("k"); ok {
		t.Fatal("expired entry served from cache")
	}
}

func TestProxyRemoteCoverURLRewritesTIDALAndWarmsCache(t *testing.T) {
	resetCoverCache(t)
	oldClient := remoteCoverHTTPClient
	remoteCoverHTTPClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode:    http.StatusOK,
				Status:        "200 OK",
				Header:        http.Header{"Content-Type": []string{"image/jpeg"}},
				Body:          io.NopCloser(strings.NewReader("jpg")),
				ContentLength: 3,
				Request:       req,
			}, nil
		}),
	}

	target := "https://resources.tidal.com/images/11/22/33/640x640.jpg"
	got := proxyRemoteCoverURL(target)
	want := "/api/covers/remote?url=" + url.QueryEscape(target)
	if got != want {
		t.Fatalf("proxyRemoteCoverURL() = %q, want %q", got, want)
	}
	// The rewrite kicks off a background warm; wait for it so the stubbed
	// client isn't restored while the fetch goroutine still needs it.
	if data := waitForCachedCover(t, target); string(data) != "jpg" {
		t.Fatalf("warmed cover bytes = %q, want jpg", data)
	}
	remoteCoverHTTPClient = oldClient
}

func TestProxyRemoteCoverURLLeavesNonTIDALAndRelativeURLsAlone(t *testing.T) {
	resetCoverCache(t)
	for _, raw := range []string{
		"",
		"/api/tracks/abc/cover",
		"https://example.com/cover.jpg",
		"http://resources.tidal.com/images/aa/640x640.jpg",
	} {
		if got := proxyRemoteCoverURL(raw); got != raw {
			t.Fatalf("proxyRemoteCoverURL(%q) = %q, want unchanged", raw, got)
		}
	}
}
