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

// maxRateLimitBuckets bounds each limiter's memory. Keys are per IPv4
// address or IPv6 /64, so reaching it takes a /47 of rotating IPv6 space
// inside one window; past it, new keys are refused rather than tracked.
const maxRateLimitBuckets = 100_000

func (rl *ipRateLimiter) allow(key string) (bool, int) {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	rl.cleanupLocked(now)

	b := rl.buckets[key]
	if b.reset.IsZero() || !now.Before(b.reset) {
		if b.reset.IsZero() && len(rl.buckets) >= maxRateLimitBuckets {
			return false, retryAfterSeconds(now, rl.nextCleanup)
		}
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

func (rl *ipRateLimiter) cleanupLocked(now time.Time) {
	if !now.After(rl.nextCleanup) {
		return
	}
	for k, b := range rl.buckets {
		if now.After(b.reset) {
			delete(rl.buckets, k)
		}
	}
	rl.nextCleanup = now.Add(rl.window)
}

// FailureLimiter counts failures per key (e.g. a username) and blocks the key
// once limit failures land inside one window. Unlike RateLimitByIP it is not
// bypassed by rotating source addresses.
type FailureLimiter struct {
	rl *ipRateLimiter
}

func NewFailureLimiter(limit int, window time.Duration) *FailureLimiter {
	return &FailureLimiter{rl: &ipRateLimiter{
		limit:   limit,
		window:  window,
		buckets: map[string]rateLimitBucket{},
	}}
}

// Reserve atomically claims one attempt for key and counts it as a failure
// up front; call Refund once the attempt turns out to be legitimate. It
// returns false, with the seconds until the window resets, when key is out of
// attempts. Claiming before the expensive check (rather than checking, then
// recording afterwards) is what stops a parallel burst from all passing the
// check before any failure lands. It fails closed: while the table is full,
// keys it isn't already tracking are refused, because their failures could
// not be recorded.
func (f *FailureLimiter) Reserve(key string) (bool, int) {
	return f.rl.allow(key)
}

// Refund returns an attempt claimed by Reserve.
func (f *FailureLimiter) Refund(key string) {
	f.rl.mu.Lock()
	defer f.rl.mu.Unlock()
	if b, ok := f.rl.buckets[key]; ok && b.count > 0 {
		b.count--
		f.rl.buckets[key] = b
	}
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

// ClientNetwork keys r's client by network: the IPv4 address, or the IPv6
// /48 one site is routinely allocated. clientKey's /64 suits request-rate
// limits, but a home connection often holds 256 /64s (a /56), so a budget
// meant to confine one guesser to its own network needs the wider prefix.
func ClientNetwork(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || host == "" {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.To4() == nil {
		return ip.Mask(net.CIDRMask(48, 128)).String() + "/48"
	}
	return clientKey(r)
}

func clientKey(r *http.Request) string {
	if r == nil {
		return "unknown"
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || host == "" {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			return v4.String()
		}
		// One IPv6 subscriber is routinely handed a whole /64; keying on
		// the full address would let them rotate through 2^64 buckets.
		return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
	}
	if r.RemoteAddr != "" {
		return r.RemoteAddr
	}
	return "unknown"
}
