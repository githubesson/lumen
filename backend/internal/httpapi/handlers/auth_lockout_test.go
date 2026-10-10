package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpapi/middleware"
)

// An attacker without the password can only feed the shared counters; a
// browser that already signed in as that user must be counted apart from them.
func TestLoginBudgetsSeparateKnownDevices(t *testing.T) {
	h := &Auth{DeviceKey: auth.DeriveKey([]byte("secret"), "known-device")}

	anon := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	anonBudgets := h.loginBudgets(anon, "admin")
	if len(anonBudgets) != 2 || anonBudgets[0].limiter != networkLoginFailures ||
		anonBudgets[1].limiter != accountLoginFailures {
		t.Fatal("request without a device cookie not charged per network and per account")
	}

	known := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	known.AddCookie(&http.Cookie{Name: auth.KnownDeviceCookie, Value: auth.SignKnownDevice(h.DeviceKey, "admin", time.Now())})
	knownBudgets := h.loginBudgets(known, "Admin")
	if len(knownBudgets) != 1 || knownBudgets[0].limiter != deviceLoginFailures {
		t.Fatal("known device shares the shared counters")
	}

	forged := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	forged.AddCookie(&http.Cookie{Name: auth.KnownDeviceCookie, Value: "9999999999.forged"})
	if b := h.loginBudgets(forged, "admin"); len(b) != 2 || b[1].limiter != accountLoginFailures {
		t.Fatal("forged device cookie escaped the shared counters")
	}

	// Long usernames cost the tables a fixed-size key.
	for _, b := range h.loginBudgets(anon, string(make([]byte, 8000))) {
		if len(b.key) != 64 {
			t.Fatalf("failure key length %d, want 64", len(b.key))
		}
	}
}

// Guesses from one network must lock out only that network: the account's
// owner signing in from elsewhere on a new browser still gets through, until
// guesses from several networks add up to the account-wide ceiling.
func TestLoginLockoutIsPerNetwork(t *testing.T) {
	oldNetwork, oldAccount := networkLoginFailures, accountLoginFailures
	networkLoginFailures = middleware.NewFailureLimiter(3, time.Hour)
	accountLoginFailures = middleware.NewFailureLimiter(7, time.Hour)
	t.Cleanup(func() { networkLoginFailures, accountLoginFailures = oldNetwork, oldAccount })

	h := &Auth{}
	from := func(addr string) []loginBudget {
		r := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		r.RemoteAddr = addr
		return h.loginBudgets(r, "victim")
	}
	attempt := func(addr string) bool {
		ok, _ := reserveLogin(from(addr))
		return ok
	}

	for i := 0; i < 3; i++ {
		if !attempt("203.0.113.7:4000") {
			t.Fatalf("attempt %d refused early", i+1)
		}
	}
	if attempt("203.0.113.7:4001") {
		t.Fatal("network budget not enforced")
	}
	// Rotating /64s inside one IPv6 site allocation buys nothing.
	for i := 0; i < 3; i++ {
		if !attempt("[2001:db8:1:2::1]:4000") {
			t.Fatalf("IPv6 attempt %d refused early", i+1)
		}
	}
	if attempt("[2001:db8:1:ff00::9]:4000") {
		t.Fatal("a sibling /64 inside the same /48 got a fresh network budget")
	}
	// Refused attempts cost the account nothing: 6 of 7 are spent, so the
	// owner's attempt from a new network fits, and then the ceiling holds.
	owner := from("198.51.100.20:5000")
	if ok, _ := reserveLogin(owner); !ok {
		t.Fatal("owner locked out by guesses from other networks")
	}
	if attempt("192.0.2.1:6000") {
		t.Fatal("account budget not enforced across networks")
	}
	// A correct password refunds the claim.
	refundLogin(owner)
	if !attempt("192.0.2.1:6000") {
		t.Fatal("refund did not return the account budget")
	}
}
