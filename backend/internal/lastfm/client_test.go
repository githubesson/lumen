package lastfm

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestSignatureMatchesAuthenticationSpec(t *testing.T) {
	params := url.Values{
		"api_key": {"xxxxxxxx"},
		"method":  {"auth.getSession"},
		"token":   {"xxxxxxx"},
		"format":  {"json"}, // explicitly excluded from the signature
	}
	if got, want := signature(params, "mysecret"), "68afb32bee072407a63b6c41f3e1e2b4"; got != want {
		t.Fatalf("signature = %q, want %q", got, want)
	}
}

func TestScrobbleSendsSignedMetadata(t *testing.T) {
	var form url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		form = r.PostForm
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"scrobbles":{"@attr":{"accepted":"1","ignored":"0"}}}`))
	}))
	defer server.Close()

	client := NewClient(Config{
		APIKey:       "key",
		SharedSecret: "secret",
		APIURL:       server.URL,
	})
	started := time.Unix(1_700_000_000, 0)
	err := client.Scrobble(context.Background(), "session", Track{
		Artist:      "Artist",
		Title:       "Track",
		Album:       "Album",
		TrackNumber: 4,
		DurationSec: 213,
		StartedAt:   started,
	})
	if err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{
		"method":       "track.scrobble",
		"artist":       "Artist",
		"track":        "Track",
		"album":        "Album",
		"trackNumber":  "4",
		"duration":     "213",
		"timestamp":    "1700000000",
		"chosenByUser": "1",
		"api_key":      "key",
		"sk":           "session",
		"format":       "json",
	} {
		if got := form.Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	signed := url.Values{}
	for key, values := range form {
		if key != "api_sig" {
			signed[key] = append([]string(nil), values...)
		}
	}
	if got, want := form.Get("api_sig"), signature(signed, "secret"); got != want {
		t.Fatalf("api_sig = %q, want %q", got, want)
	}
}
