package handlers

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sync/semaphore"
	"golang.org/x/sync/singleflight"
)

const (
	// maxConcurrentTIDALAudio bounds full-track TIDAL downloads made for
	// preview/story renders. Each can be up to maxPreviewSourceBytes in the
	// (often RAM-backed) temp dir, and the public signed endpoints reach this
	// without a session.
	maxConcurrentTIDALAudio = 2
	// publicBuildTimeout bounds a coalesced public build, which runs detached
	// from any one request so a disconnecting client can't fail it for others.
	publicBuildTimeout = 7 * time.Minute
	// publicBuildFailureTTL is how long a failed public build is remembered.
	// Without it every request for a broken track re-downloads it in full.
	publicBuildFailureTTL  = 5 * time.Minute
	maxPublicBuildFailures = 4096
)

var (
	tidalAudioSem    = semaphore.NewWeighted(maxConcurrentTIDALAudio)
	publicBuilds     singleflight.Group
	publicBuildFails = newFailureCache(publicBuildFailureTTL, maxPublicBuildFailures)

	errRecentBuildFailure = errors.New("preview build failed recently")
)

// audioResolveError marks a failure to materialize the source audio so the
// handler can answer with writeAudioResolveError.
type audioResolveError struct{ err error }

func (e audioResolveError) Error() string { return e.err.Error() }
func (e audioResolveError) Unwrap() error { return e.err }

// buildPublicMedia runs build at most once concurrently per key and, after a
// failure, short-circuits the key for publicBuildFailureTTL. The key must
// cover everything the output depends on (kind, track, start, duration).
func buildPublicMedia(r *http.Request, key string, build func(context.Context) (string, error)) (string, error) {
	if publicBuildFails.recent(key) {
		return "", errRecentBuildFailure
	}
	ch := publicBuilds.DoChan(key, func() (any, error) {
		// A caller that passed the check above may only reach DoChan after
		// another caller's build failed; don't start a fresh one then.
		if publicBuildFails.recent(key) {
			return "", errRecentBuildFailure
		}
		// Detached so one client disconnecting can't fail the build for the
		// others waiting on it.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), publicBuildTimeout)
		defer cancel()
		out, err := build(ctx)
		if err != nil {
			publicBuildFails.add(key)
			return "", err
		}
		return out, nil
	})
	select {
	case res := <-ch:
		if res.Err != nil {
			return "", res.Err
		}
		return res.Val.(string), nil
	case <-r.Context().Done():
		// Stop waiting; the shared build keeps running for other callers.
		return "", r.Context().Err()
	}
}

func publicBuildKey(kind, trackID string, startSec, durationSec int) string {
	return kind + "|" + trackID + "|" + strconv.Itoa(startSec) + "|" + strconv.Itoa(durationSec)
}

// writePublicBuildError maps a buildPublicMedia failure to a response.
func writePublicBuildError(w http.ResponseWriter, err error, failMsg string) {
	var audioErr audioResolveError
	switch {
	case errors.Is(err, errRecentBuildFailure):
		w.Header().Set("Retry-After", strconv.Itoa(int(publicBuildFailureTTL/time.Second)))
		http.Error(w, "preview temporarily unavailable", http.StatusServiceUnavailable)
	case errors.As(err, &audioErr):
		writeAudioResolveError(w, audioErr.err)
	default:
		http.Error(w, failMsg, http.StatusInternalServerError)
	}
}

// failureCache remembers keys for a fixed TTL, bounded to max entries.
type failureCache struct {
	ttl time.Duration
	max int

	mu    sync.Mutex
	until map[string]time.Time
}

func newFailureCache(ttl time.Duration, max int) *failureCache {
	return &failureCache{ttl: ttl, max: max, until: map[string]time.Time{}}
}

func (c *failureCache) recent(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	t, ok := c.until[key]
	if !ok {
		return false
	}
	if time.Now().After(t) {
		delete(c.until, key)
		return false
	}
	return true
}

func (c *failureCache) add(key string) {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.until) >= c.max {
		for k, t := range c.until {
			if now.After(t) {
				delete(c.until, k)
			}
		}
		if len(c.until) >= c.max {
			slog.Warn("preview failure cache full; resetting", "entries", len(c.until))
			c.until = map[string]time.Time{}
		}
	}
	c.until[key] = now.Add(c.ttl)
}
