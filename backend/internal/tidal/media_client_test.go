package tidal

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/githubesson/lumen/internal/httpx"
)

func TestTIDALMediaClientRejectsOffHostRedirects(t *testing.T) {
	offHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<script>alert(1)</script>"))
	}))
	defer offHost.Close()
	// Both servers listen on 127.0.0.1; reach the off-host one via
	// "localhost" so the two differ by hostname.
	offHostURL, err := url.Parse(offHost.URL)
	if err != nil {
		t.Fatal(err)
	}
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://localhost:"+offHostURL.Port()+"/evil.html", http.StatusFound)
	}))
	defer origin.Close()

	prev := mediaHostAllowed
	mediaHostAllowed = func(host string) bool { return host == "127.0.0.1" }
	defer func() { mediaHostAllowed = prev }()

	resp, err := tidalMediaClient(&http.Client{}).Get(origin.URL)
	if err == nil {
		resp.Body.Close()
		t.Fatal("redirect to a non-TIDAL host was followed")
	}
	if !strings.Contains(err.Error(), "redirect host is not allowed") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestTIDALMediaClientFollowsAllowedRedirects(t *testing.T) {
	var target *httptest.Server
	target = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, target.URL+"/media", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer target.Close()
	prev := mediaHostAllowed
	mediaHostAllowed = func(string) bool { return true }
	defer func() { mediaHostAllowed = prev }()

	resp, err := tidalMediaClient(&http.Client{}).Get(target.URL + "/start")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.Request.URL.Path != "/media" {
		t.Fatalf("final path = %q", resp.Request.URL.Path)
	}
}

func TestReadCappedRejectsInsteadOfTruncating(t *testing.T) {
	if b, err := readCapped(strings.NewReader("12345"), 5); err != nil || string(b) != "12345" {
		t.Fatalf("at the cap: %q, %v", b, err)
	}
	if b, err := readCapped(strings.NewReader("123456"), 5); err != errCoverTooLarge || b != nil {
		t.Fatalf("past the cap: %q, %v", b, err)
	}
}

// Cover art, written into downloads, is fetched over HTTPS only, even from a
// TIDAL host and even by a redirect.
func TestCoverBytesRequiresHTTPS(t *testing.T) {
	ctx := context.Background()
	if _, err := NewClient(Config{}).CoverBytes(ctx, "http://resources.tidal.com/images/ab/cd/640x640.jpg"); !errors.Is(err, errCoverNotHTTPS) {
		t.Fatalf("http cover: err = %v", err)
	}

	var plainHits atomic.Int32
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		plainHits.Add(1)
		_, _ = w.Write([]byte("image"))
	}))
	defer plain.Close()
	cdn := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/downgrade.jpg" {
			http.Redirect(w, r, plain.URL+"/cover.jpg", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("image"))
	}))
	defer cdn.Close()
	prevHost, prevPolicy := mediaHostAllowed, mediaDownloadPolicy
	mediaHostAllowed = func(host string) bool { return host == "127.0.0.1" }
	mediaDownloadPolicy = httpx.DownloadPolicy{AllowLoopback: true}
	defer func() { mediaHostAllowed, mediaDownloadPolicy = prevHost, prevPolicy }()
	c := NewClient(Config{})
	c.stream = cdn.Client()

	if b, err := c.CoverBytes(ctx, cdn.URL+"/cover.jpg"); err != nil || string(b) != "image" {
		t.Fatalf("https cover: %q, %v", b, err)
	}
	if _, err := c.CoverBytes(ctx, cdn.URL+"/downgrade.jpg"); !errors.Is(err, errCoverNotHTTPS) || plainHits.Load() != 0 {
		t.Fatalf("redirect to http: err = %v, plain hits %d", err, plainHits.Load())
	}
}
