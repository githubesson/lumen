package middleware

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestClientKeyGroupsIPv6By64(t *testing.T) {
	key := func(remote string) string {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = remote
		return clientKey(r)
	}
	if a, b := key("[2001:db8:1:2::1]:443"), key("[2001:db8:1:2:ffff:ffff:ffff:ffff]:443"); a != b {
		t.Fatalf("addresses in one /64 got different keys: %q vs %q", a, b)
	}
	if a, b := key("[2001:db8:1:2::1]:443"), key("[2001:db8:1:3::1]:443"); a == b {
		t.Fatalf("different /64s share key %q", a)
	}
	if got := key("203.0.113.7:5000"); got != "203.0.113.7" {
		t.Fatalf("IPv4 key = %q", got)
	}
	if got := key("[::ffff:203.0.113.7]:5000"); got != "203.0.113.7" {
		t.Fatalf("IPv4-mapped key = %q", got)
	}
}

func TestClientNetworkGroupsIPv6By48(t *testing.T) {
	key := func(remote string) string {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = remote
		return ClientNetwork(r)
	}
	if a, b := key("[2001:db8:1:2::1]:443"), key("[2001:db8:1:ff00::9]:443"); a != b {
		t.Fatalf("/64s in one /48 got different keys: %q vs %q", a, b)
	}
	if a, b := key("[2001:db8:1::1]:443"), key("[2001:db8:2::1]:443"); a == b {
		t.Fatalf("different /48s share key %q", a)
	}
	if got := key("[::ffff:203.0.113.7]:5000"); got != "203.0.113.7" {
		t.Fatalf("IPv4-mapped key = %q", got)
	}
}

// Rotating /64s inside one /48 must not buy a fresh login budget.
func TestRateLimitByNetworkSharesBudgetAcrossA48(t *testing.T) {
	h := RateLimitByNetwork(2, time.Minute)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	status := func(remote string) int {
		r := httptest.NewRequest("POST", "/api/auth/login", nil)
		r.RemoteAddr = remote
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec.Code
	}
	for i, remote := range []string{"[2001:db8:1:1::1]:1", "[2001:db8:1:2::1]:1"} {
		if got := status(remote); got != http.StatusOK {
			t.Fatalf("request %d = %d", i+1, got)
		}
	}
	if got := status("[2001:db8:1:3::1]:1"); got != http.StatusTooManyRequests {
		t.Fatalf("third /64 in the /48 = %d, want 429", got)
	}
	if got := status("[2001:db8:2::1]:1"); got != http.StatusOK {
		t.Fatalf("another /48 = %d", got)
	}
}

func TestFailureLimiterReserveAndRefund(t *testing.T) {
	f := NewFailureLimiter(3, time.Minute)
	for i := range 3 {
		if ok, _ := f.Reserve("admin"); !ok {
			t.Fatalf("attempt %d refused before the limit", i+1)
		}
	}
	ok, retry := f.Reserve("admin")
	if ok || retry <= 0 {
		t.Fatalf("fourth attempt allowed: ok=%v retry=%d", ok, retry)
	}
	f.Refund("admin")
	if ok, _ := f.Reserve("admin"); !ok {
		t.Fatal("refunded attempt not returned")
	}
	if ok, _ := f.Reserve("someone-else"); !ok {
		t.Fatal("unrelated key refused")
	}
}

// A parallel burst must not get more attempts than the limit.
func TestFailureLimiterReserveIsAtomic(t *testing.T) {
	f := NewFailureLimiter(10, time.Minute)
	var wg sync.WaitGroup
	var allowed atomic.Int32
	for range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, _ := f.Reserve("admin"); ok {
				allowed.Add(1)
			}
		}()
	}
	wg.Wait()
	if n := allowed.Load(); n != 10 {
		t.Fatalf("%d parallel attempts allowed, want 10", n)
	}
}

func TestRateLimiterRefusesNewKeysWhenFull(t *testing.T) {
	rl := &ipRateLimiter{limit: 1, window: time.Minute, buckets: map[string]rateLimitBucket{}}
	rl.nextCleanup = time.Now().Add(time.Minute)
	reset := time.Now().Add(time.Minute)
	for i := range maxRateLimitBuckets {
		rl.buckets["k"+strconv.Itoa(i)] = rateLimitBucket{count: 1, reset: reset}
	}
	if ok, _ := rl.allow("new-client"); ok {
		t.Fatal("full limiter admitted and tracked a new key")
	}
	if len(rl.buckets) > maxRateLimitBuckets {
		t.Fatalf("bucket map grew past cap: %d", len(rl.buckets))
	}
}

func TestFailureLimiterFailsClosedWhenFull(t *testing.T) {
	f := NewFailureLimiter(10, time.Minute)
	f.rl.nextCleanup = time.Now().Add(time.Minute)
	reset := time.Now().Add(time.Minute)
	for i := range maxRateLimitBuckets {
		f.rl.buckets["k"+strconv.Itoa(i)] = rateLimitBucket{count: 1, reset: reset}
	}
	if ok, retry := f.Reserve("untracked"); ok || retry <= 0 {
		t.Fatalf("untracked key allowed while the table is full: ok=%v retry=%d", ok, retry)
	}
	if ok, _ := f.Reserve("k1"); !ok {
		t.Fatal("tracked key under its limit was refused")
	}
}
