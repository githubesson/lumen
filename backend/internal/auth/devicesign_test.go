package auth

import (
	"testing"
	"time"
)

func TestKnownDeviceToken(t *testing.T) {
	key := DeriveKey([]byte("secret"), "known-device")
	now := time.Unix(1_800_000_000, 0)
	token := SignKnownDevice(key, "Admin", now)

	if !VerifyKnownDevice(key, token, "admin", now) {
		t.Fatal("valid token rejected (username match must be case-insensitive)")
	}
	if VerifyKnownDevice(key, token, "someone-else", now) {
		t.Fatal("token accepted for a different username")
	}
	if VerifyKnownDevice(key, token, "admin", now.Add(KnownDeviceValidity+time.Second)) {
		t.Fatal("expired token accepted")
	}
	if VerifyKnownDevice(DeriveKey([]byte("secret"), "other"), token, "admin", now) {
		t.Fatal("token verified under a different subkey")
	}
	if VerifyKnownDevice(nil, token, "admin", now) {
		t.Fatal("token verified with no key configured")
	}
	for _, bad := range []string{"", "nodot", "123.", ".sig", "abc.sig"} {
		if VerifyKnownDevice(key, bad, "admin", now) {
			t.Fatalf("malformed token %q accepted", bad)
		}
	}
}
