package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"
)

// This file holds the HMAC-SHA256 signing primitives shared by the cover and
// share/preview signed-URL families (coversign.go, sharesign.go). Each of those
// only defines its own payload format and validity; the MAC computation,
// expiry bucketing, and verification ladders live here so a change to the
// algorithm or constant-time policy happens in exactly one place.

// signMessage returns the base64url (no padding) HMAC-SHA256 of msg under key.
func signMessage(key []byte, msg string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(msg))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// verifyMessage reports whether sig is the valid signature of msg under key,
// using a constant-time comparison.
func verifyMessage(key []byte, msg, sig string) bool {
	return hmac.Equal([]byte(signMessage(key, msg)), []byte(sig))
}

// expiryBucket rounds now down to the top of the hour and adds validity, so
// repeated signs within the same hour yield a stable expiry — and therefore a
// stable URL that Discord's CDN can keep cached instead of re-fetching.
func expiryBucket(now time.Time, validity time.Duration) int64 {
	return now.Truncate(time.Hour).Add(validity).Unix()
}

// checkExpiry validates the key/exp/now triple of an expiry-bearing signed URL.
// label names the resource ("cover", "preview") for the not-configured error.
func checkExpiry(key []byte, expUnix int64, now time.Time, label string) error {
	if len(key) == 0 {
		return fmt.Errorf("%s sign key not configured", label)
	}
	if expUnix <= 0 {
		return errors.New("missing or invalid exp")
	}
	if now.Unix() > expUnix {
		return errors.New("signed URL expired")
	}
	return nil
}
