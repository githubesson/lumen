package handlers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTIDALProxyContentType(t *testing.T) {
	for upstream, want := range map[string]string{
		"":                              "audio/mp4",
		"audio/flac":                    "audio/flac",
		"audio/mp4; codecs=mp4a.40.2":   "audio/mp4; codecs=mp4a.40.2",
		"video/mp2t":                    "video/mp2t",
		"application/vnd.apple.mpegurl": "application/vnd.apple.mpegurl",
		"text/html; charset=utf-8":      "application/octet-stream",
		"image/svg+xml":                 "application/octet-stream",
		"application/dash+xml":          "application/octet-stream",
		"application/xhtml+xml":         "application/octet-stream",
		"not a / valid ; type ===":      "application/octet-stream",
	} {
		if got := tidalProxyContentType(upstream); got != want {
			t.Errorf("tidalProxyContentType(%q) = %q, want %q", upstream, got, want)
		}
	}
}

func TestWriteTIDALProxyResponseNeverEchoesRenderableType(t *testing.T) {
	rec := httptest.NewRecorder()
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/html"}},
		Body:       http.NoBody,
	}
	writeTIDALProxyResponse(rec, resp)
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("missing nosniff")
	}
}

func TestBuildPublicMediaCoalescesAndRemembersFailures(t *testing.T) {
	key := publicBuildKey("test", t.Name(), 0, 30)
	req := httptest.NewRequest(http.MethodGet, "/", nil)

	var calls atomic.Int32
	release := make(chan struct{})
	build := func(context.Context) (string, error) {
		calls.Add(1)
		<-release
		return "", errors.New("ffmpeg exploded")
	}
	var wg sync.WaitGroup
	errs := make([]error, 5)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = buildPublicMedia(req, key, build)
		}(i)
	}
	// Let every goroutine join the in-flight build before it fails.
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()
	if n := calls.Load(); n != 1 {
		t.Fatalf("build ran %d times, want 1", n)
	}
	for i, err := range errs {
		if err == nil {
			t.Fatalf("request %d succeeded", i)
		}
	}

	_, err := buildPublicMedia(req, key, func(context.Context) (string, error) {
		t.Fatal("build retried during failure TTL")
		return "", nil
	})
	if !errors.Is(err, errRecentBuildFailure) {
		t.Fatalf("err = %v, want errRecentBuildFailure", err)
	}
	rec := httptest.NewRecorder()
	writePublicBuildError(rec, err, "failed")
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("recent failure response = %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestFailureCacheExpiresAndStaysBounded(t *testing.T) {
	c := newFailureCache(time.Hour, 2)
	c.add("a")
	c.add("b")
	c.add("c") // full with live entries: resets rather than growing
	if len(c.until) > 2 {
		t.Fatalf("cache grew to %d entries", len(c.until))
	}
	if !c.recent("c") {
		t.Fatal("newest entry missing")
	}

	expired := newFailureCache(-time.Second, 10)
	expired.add("x")
	if expired.recent("x") {
		t.Fatal("expired entry still reported")
	}
}

func TestBuildPublicMediaCanceledWaiterLeavesBuildRunning(t *testing.T) {
	key := publicBuildKey("test", t.Name(), 0, 30)
	started := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	build := func(ctx context.Context) (string, error) {
		close(started)
		<-release
		defer close(finished)
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "/cache/out.mp4", nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
	errCh := make(chan error, 1)
	go func() {
		_, err := buildPublicMedia(req, key, build)
		errCh <- err
	}()
	<-started
	cancel()
	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("waiter err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled waiter kept blocking on the shared build")
	}

	// A second caller joins the still-running build and gets its result.
	resCh := make(chan string, 1)
	go func() {
		out, _ := buildPublicMedia(httptest.NewRequest(http.MethodGet, "/", nil), key, build)
		resCh <- out
	}()
	time.Sleep(20 * time.Millisecond)
	close(release)
	<-finished
	if out := <-resCh; out != "/cache/out.mp4" {
		t.Fatalf("joined build result = %q", out)
	}
}
