package auth

import (
	"testing"
	"time"
)

var signKey = []byte("test-signing-key-0123456789")

func TestCoverSignRoundTrip(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	exp, sig := SignCoverURL(signKey, "album", "abc-123", now)
	if exp <= now.Unix() {
		t.Fatalf("exp %d should be in the future of now %d", exp, now.Unix())
	}
	if err := VerifyCoverURL(signKey, "album", "abc-123", sig, exp, now); err != nil {
		t.Fatalf("valid cover sig rejected: %v", err)
	}
	// Tampered id must fail.
	if err := VerifyCoverURL(signKey, "album", "other", sig, exp, now); err == nil {
		t.Fatal("expected signature mismatch for a different id")
	}
	// Expired must fail.
	if err := VerifyCoverURL(signKey, "album", "abc-123", sig, exp, time.Unix(exp+1, 0)); err == nil {
		t.Fatal("expected expired error past exp")
	}
	// Empty key must fail.
	if err := VerifyCoverURL(nil, "album", "abc-123", sig, exp, now); err == nil {
		t.Fatal("expected not-configured error for empty key")
	}
}

func TestShareSignRoundTrip(t *testing.T) {
	sig := SignShareURL(signKey, "track-9", 42)
	if err := VerifyShareURL(signKey, "track-9", 42, sig); err != nil {
		t.Fatalf("valid share sig rejected: %v", err)
	}
	if err := VerifyShareURL(signKey, "track-9", 43, sig); err == nil {
		t.Fatal("expected mismatch for a different start_sec")
	}
}

func TestPreviewSignRoundTrip(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	exp, sig := SignPreviewURL(signKey, "track-9", 42, now)
	if err := VerifyPreviewURL(signKey, "track-9", 42, sig, exp, now); err != nil {
		t.Fatalf("valid preview sig rejected: %v", err)
	}
	if err := VerifyPreviewURL(signKey, "track-9", 42, sig, exp, time.Unix(exp+1, 0)); err == nil {
		t.Fatal("expected expired error past exp")
	}
}

// TestSignatureWireFormat pins the exact signature bytes for fixed inputs so a
// future change to the signing internals that would invalidate already-issued
// URLs fails loudly here.
func TestSignatureWireFormat(t *testing.T) {
	exp := int64(1_700_007_200)
	if got := computeCoverSig(signKey, "album", "abc-123", exp); got != signMessage(signKey, "album|abc-123|1700007200") {
		t.Fatalf("cover payload format changed: %q", got)
	}
	if got := computeShareSig(signKey, "track-9", 42); got != signMessage(signKey, "share|track|track-9|42") {
		t.Fatalf("share payload format changed: %q", got)
	}
	if got := computePreviewSig(signKey, "track-9", 42, exp); got != signMessage(signKey, "preview|track|track-9|42|1700007200") {
		t.Fatalf("preview payload format changed: %q", got)
	}
}
