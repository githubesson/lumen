package middleware

import (
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type rateLimitBucket struct {
	count int
	reset time.Time
}

type ipRateLimiter struct {
	mu          sync.Mutex
	limit       int
	window      time.Duration
	buckets     map[string]rateLimitBucket
	nextCleanup time.Time
}

// RateLimitByIP returns a small in-process fixed-window limiter for endpoints
// that do expensive work. It is intentionally local to this process; production
// deployments should still prefer an edge limiter when one is available.
func RateLimitByIP(limit int, window time.Duration) func(http.Handler) http.Handler {
	rl := &ipRateLimiter{
		limit:   limit,
		window:  window,
		buckets: map[string]rateLimitBucket{},
	}
	return rl.middleware
}

func (rl *ipRateLimiter) middleware(next http.Handler) http.Handler {
	if rl.limit <= 0 || rl.window <= 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok, retryAfter := rl.allow(clientKey(r))
		if !ok {
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (rl *ipRateLimiter) allow(key string) (bool, int) {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	if now.After(rl.nextCleanup) {
		for k, b := range rl.buckets {
			if now.After(b.reset) {
				delete(rl.buckets, k)
			}
		}
		rl.nextCleanup = now.Add(rl.window)
	}

	b := rl.buckets[key]
	if b.reset.IsZero() || !now.Before(b.reset) {
		rl.buckets[key] = rateLimitBucket{count: 1, reset: now.Add(rl.window)}
		return true, 0
	}
	if b.count >= rl.limit {
		return false, retryAfterSeconds(now, b.reset)
	}
	b.count++
	rl.buckets[key] = b
	return true, 0
}

func retryAfterSeconds(now, reset time.Time) int {
	d := reset.Sub(now)
	if d <= 0 {
		return 1
	}
	seconds := int((d + time.Second - 1) / time.Second)
	if seconds < 1 {
		return 1
	}
	return seconds
}

func clientKey(r *http.Request) string {
	if r == nil {
		return "unknown"
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	if ip := net.ParseIP(r.RemoteAddr); ip != nil {
		return ip.String()
	}
	if r.RemoteAddr != "" {
		return r.RemoteAddr
	}
	return "unknown"
}
