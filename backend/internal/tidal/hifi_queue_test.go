package tidal

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const queuedManifestURL = "https://im-fa.manifest.tidal.com/1/manifests/queued.m3u8?token=abc"

func queueTicket(w http.ResponseWriter, location string) {
	w.Header().Set("Location", location)
	w.Header().Set("Retry-After", "0")
	w.Header().Set("X-Playback-Queue-Position", "1")
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write([]byte(`{"status":"pending","queuePosition":1}`))
}

func TestStreamURLWaitsInPlaybackQueue(t *testing.T) {
	var polls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/trackManifests/":
			queueTicket(w, "/playback/requests/abc")
		case r.Method == http.MethodGet && r.URL.Path == "/playback/requests/abc":
			if polls.Add(1) < 3 {
				queueTicket(w, "/playback/requests/abc")
				return
			}
			_, _ = w.Write([]byte(`{"version":"2.10","data":{"data":{"attributes":{"trackPresentation":"FULL","uri":"` + queuedManifestURL + `"}}}}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL})
	got, err := c.StreamURL(context.Background(), "123")
	if err != nil {
		t.Fatalf("StreamURL returned error: %v", err)
	}
	if got != queuedManifestURL {
		t.Fatalf("StreamURL = %q, want %q", got, queuedManifestURL)
	}
	if n := polls.Load(); n != 3 {
		t.Fatalf("polls = %d, want 3", n)
	}
}

func TestQueuedPlaybackFailureIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/playback/requests/abc" {
			http.Error(w, `{"detail":"Upstream API error"}`, http.StatusBadGateway)
			return
		}
		queueTicket(w, "/playback/requests/abc")
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL})
	var out struct{}
	err := c.doHifiJSON(context.Background(), srv.URL+"/track/?id=1", &out)
	if err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("err = %v, want the queued request's 502", err)
	}
}

func TestQueuedPlaybackIsCancelledWhenCallerGivesUp(t *testing.T) {
	deleted := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deleted <- r.URL.Path
			_, _ = w.Write([]byte(`{"status":"cancelled"}`))
			return
		}
		queueTicket(w, "/playback/requests/abc")
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL})
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	var out struct{}
	if err := c.doHifiJSON(ctx, srv.URL+"/trackManifests/?id=1", &out); err != context.DeadlineExceeded {
		t.Fatalf("err = %v, want deadline exceeded", err)
	}
	select {
	case path := <-deleted:
		if path != "/playback/requests/abc" {
			t.Fatalf("DELETE %s, want /playback/requests/abc", path)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("queued playback request was not cancelled")
	}
}

func TestQueuedPlaybackOnlyFollowsItsOwnQueue(t *testing.T) {
	var elsewhere atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		elsewhere.Add(1)
	}))
	defer other.Close()

	for _, location := range []string{
		"",
		other.URL + "/playback/requests/abc",
		"//" + strings.TrimPrefix(other.URL, "http://") + "/playback/requests/abc",
		"/lumen/accounts/abc",
		"/playback/requests/",
	} {
		t.Run(location, func(t *testing.T) {
			var followed atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/trackManifests/" {
					followed.Add(1)
				}
				w.Header().Set("Location", location)
				w.WriteHeader(http.StatusAccepted)
			}))
			defer srv.Close()

			c := NewClient(Config{HifiAPIURL: srv.URL})
			var out struct{}
			if err := c.doHifiJSON(context.Background(), srv.URL+"/trackManifests/?id=1", &out); err == nil {
				t.Fatal("queued playback with a bad Location succeeded")
			}
			if followed.Load() != 0 {
				t.Fatal("followed a bad Location on the hifi-api host")
			}
		})
	}
	if elsewhere.Load() != 0 {
		t.Fatal("followed a Location to another host")
	}
}

func TestPlaybackRetryDelay(t *testing.T) {
	for header, want := range map[string]time.Duration{
		"":          time.Second,
		"soon":      time.Second,
		"0":         playbackQueueMinPoll,
		"-3":        playbackQueueMinPoll,
		"1":         time.Second,
		"2":         2 * time.Second,
		"5":         playbackQueueMaxPoll,
		"999999999": playbackQueueMaxPoll,
	} {
		if got := playbackRetryDelay(header); got != want {
			t.Errorf("playbackRetryDelay(%q) = %v, want %v", header, got, want)
		}
	}
}
