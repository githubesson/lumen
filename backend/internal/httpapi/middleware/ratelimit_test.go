package middleware

import (
	"net/http/httptest"
	"strconv"
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

func TestFailureLimiterBlocksAfterLimit(t *testing.T) {
	f := NewFailureLimiter(3, time.Minute)
	for i := range 3 {
		if blocked, _ := f.Blocked("admin"); blocked {
			t.Fatalf("blocked after %d failures", i)
		}
		f.Fail("admin")
	}
	blocked, retry := f.Blocked("admin")
	if !blocked || retry <= 0 {
		t.Fatalf("not blocked after limit: blocked=%v retry=%d", blocked, retry)
	}
	if blocked, _ := f.Blocked("someone-else"); blocked {
		t.Fatal("unrelated key blocked")
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
