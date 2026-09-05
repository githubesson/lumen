package sourceurl

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestResolveHostRouting(t *testing.T) {
	for _, tc := range []struct{ source, want, imgurID string }{
		{"https://pillows.su/f/abc", "https://api.pillows.su/api/download/abc", ""},
		{"https://sub.pillows.su/f/abc", "https://api.pillows.su/api/download/abc", ""},
		{"https://pillows.su.evil.test/f/abc", "https://pillows.su.evil.test/f/abc", ""},
		{"https://imgur.gg/f/abc", "https://cdn.test/song.mp3", "abc"},
		{"https://imgur.gg/abc", "https://cdn.test/song.mp3", "abc"},
		{"https://imgur.gg/", "https://imgur.gg/", ""},
	} {
		t.Run(tc.source, func(t *testing.T) {
			var called string
			got, err := Resolve(context.Background(), tc.source, func(_ context.Context, id string) (string, error) {
				called = id
				return "https://cdn.test/song.mp3", nil
			})
			if err != nil || got != tc.want || called != tc.imgurID {
				t.Fatalf("got %q, resolver id %q, error %v", got, called, err)
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestImgurUsesInjectedClientAndContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Context() != ctx || r.Method != "POST" || r.URL.String() != "https://imgur.gg/api/file/abc/download" {
			t.Fatalf("unexpected request: %v", r)
		}
		if r.Header.Get("Origin") != "https://imgur.gg" || r.Header.Get("Referer") != "https://imgur.gg/f/abc" {
			t.Fatalf("lost host headers: %v", r.Header)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"url":"https://cdn.test/song.mp3"}`)), Header: make(http.Header)}, nil
	})}
	got, err := ResolveImgurGG(ctx, "abc", client)
	if err != nil || got != "https://cdn.test/song.mp3" {
		t.Fatalf("got %q %v", got, err)
	}
}
