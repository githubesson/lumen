package auth

import (
	"errors"
	"fmt"
	"strconv"
	"time"
)

// Public signed cover URLs let Discord's media proxy (which fetches
// `large_image` server-side with no cookies) reach album artwork without
// going through the session-auth wall. The signature covers the resource
// kind + id + expiry, so a leaked URL can't be pivoted to a different
// album and auto-rotates.

// CoverSignValidity is how long an issued signed cover URL stays valid.
// Short enough that a leaked URL is low-value, long enough that Discord's
// CDN can keep the image cached through a typical listening session.
const CoverSignValidity = 2 * time.Hour

// SignCoverURL returns the (exp, sig) pair for a cover resource. `kind` is
// "album" (the only resource currently signed); `id` is the album UUID as
// its canonical string form.
func SignCoverURL(key []byte, kind, id string, now time.Time) (exp int64, sig string) {
	exp = expiryBucket(now, CoverSignValidity)
	sig = computeCoverSig(key, kind, id, exp)
	return exp, sig
}

// VerifyCoverURL returns nil iff the signature matches and the URL hasn't
// expired. Uses constant-time comparison for the signature check.
func VerifyCoverURL(key []byte, kind, id, sig string, expUnix int64, now time.Time) error {
	if err := checkExpiry(key, expUnix, now, "cover"); err != nil {
		return err
	}
	if !verifyMessage(key, coverSigPayload(kind, id, expUnix), sig) {
		return errors.New("signature mismatch")
	}
	return nil
}

func computeCoverSig(key []byte, kind, id string, exp int64) string {
	return signMessage(key, coverSigPayload(kind, id, exp))
}

// coverSigPayload is the signed message for a cover URL. Pipe separators are
// fine since no field contains a pipe (kind is a fixed enum, id is a UUID, exp
// is decimal digits).
func coverSigPayload(kind, id string, exp int64) string {
	return fmt.Sprintf("%s|%s|%d", kind, id, exp)
}

// FormatExp is a tiny helper so callers don't have to import strconv just to
// render an `exp` query param.
func FormatExp(exp int64) string {
	return strconv.FormatInt(exp, 10)
}
