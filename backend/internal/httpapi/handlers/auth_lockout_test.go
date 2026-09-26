package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/githubesson/lumen/internal/auth"
)

// An attacker without the password can only feed the per-username counter; a
// browser that already signed in as that user must be counted apart from it.
func TestLoginFailureCounterSeparatesKnownDevices(t *testing.T) {
	h := &Auth{DeviceKey: auth.DeriveKey([]byte("secret"), "known-device")}

	anon := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	counter, anonKey := h.loginFailureCounter(anon, "admin")
	if counter != loginFailures {
		t.Fatal("request without a device cookie not counted per username")
	}

	known := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	known.AddCookie(&http.Cookie{Name: auth.KnownDeviceCookie, Value: auth.SignKnownDevice(h.DeviceKey, "admin", time.Now())})
	counter, knownKey := h.loginFailureCounter(known, "Admin")
	if counter != deviceLoginFailures || knownKey == anonKey {
		t.Fatal("known device shares the per-username counter")
	}

	forged := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	forged.AddCookie(&http.Cookie{Name: auth.KnownDeviceCookie, Value: "9999999999.forged"})
	if counter, _ := h.loginFailureCounter(forged, "admin"); counter != loginFailures {
		t.Fatal("forged device cookie escaped the per-username counter")
	}

	// Long usernames cost the table a fixed-size key.
	if _, key := h.loginFailureCounter(anon, string(make([]byte, 8000))); len(key) != 64 {
		t.Fatalf("failure key length %d, want 64", len(key))
	}
}
