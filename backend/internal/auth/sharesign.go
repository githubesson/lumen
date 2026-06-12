package auth

import (
	"errors"
	"fmt"
	"time"
)

// Share links are the URLs a user copies into Discord / chat apps. The
// signature proves an authenticated user minted the link — without it, the
// /share/track/{id}?t=N endpoint would let anyone cause preview MP4s to be
// generated for arbitrary (track, start_sec) pairs.
//
// Unlike cover signatures these *don't* carry an `exp` — share links are
// meant to live indefinitely in chat history. The signature is only
// invalidated if the HMAC secret rotates.

// SignShareURL returns the HMAC signature for a (track, start_sec) share
// link.
func SignShareURL(key []byte, trackID string, startSec int) string {
	return computeShareSig(key, trackID, startSec)
}

// VerifyShareURL returns nil iff the signature matches. No expiry check —
// share URLs are long-lived (see the package comment above).
func VerifyShareURL(key []byte, trackID string, startSec int, sig string) error {
	if len(key) == 0 {
		return errors.New("share sign key not configured")
	}
	if !verifyMessage(key, shareSigPayload(trackID, startSec), sig) {
		return errors.New("signature mismatch")
	}
	return nil
}

func computeShareSig(key []byte, trackID string, startSec int) string {
	return signMessage(key, shareSigPayload(trackID, startSec))
}

func shareSigPayload(trackID string, startSec int) string {
	return fmt.Sprintf("share|track|%s|%d", trackID, startSec)
}

// PreviewSignValidity mirrors CoverSignValidity — Discord's media proxy
// caches the fetched MP4 roughly for the lifetime of the signature, so a
// couple of hours is a good balance between "URL rotates often" and
// "bandwidth savings."
const PreviewSignValidity = 2 * time.Hour

// SignPreviewURL returns (exp, sig) for the public preview MP4 URL. The
// signature binds track + startSec + exp, matching the cover-sign pattern.
func SignPreviewURL(key []byte, trackID string, startSec int, now time.Time) (exp int64, sig string) {
	exp = expiryBucket(now, PreviewSignValidity)
	sig = computePreviewSig(key, trackID, startSec, exp)
	return exp, sig
}

// VerifyPreviewURL checks the signature and expiry.
func VerifyPreviewURL(key []byte, trackID string, startSec int, sig string, expUnix int64, now time.Time) error {
	if err := checkExpiry(key, expUnix, now, "preview"); err != nil {
		return err
	}
	if !verifyMessage(key, previewSigPayload(trackID, startSec, expUnix), sig) {
		return errors.New("signature mismatch")
	}
	return nil
}

func computePreviewSig(key []byte, trackID string, startSec int, exp int64) string {
	return signMessage(key, previewSigPayload(trackID, startSec, exp))
}

func previewSigPayload(trackID string, startSec int, exp int64) string {
	return fmt.Sprintf("preview|track|%s|%d|%d", trackID, startSec, exp)
}
