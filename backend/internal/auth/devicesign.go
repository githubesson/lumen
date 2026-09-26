package auth

import (
	"strconv"
	"strings"
	"time"
)

// Known-device tokens mark a browser that has already signed in as a given
// username. Login lockout after repeated failures applies per username, so on
// its own anyone who knows a name could keep that account locked out; a
// browser holding a valid token for the name is judged only on its own
// failures instead, which an attacker without the password can't produce.

// KnownDeviceCookie is the cookie that carries the token.
const KnownDeviceCookie = "lumen_known_device"

// KnownDeviceValidity is how long a known-device token lasts after the
// sign-in that issued it.
const KnownDeviceValidity = 90 * 24 * time.Hour

func knownDeviceMessage(username string, exp int64) string {
	return "known-device|" + strings.ToLower(username) + "|" + strconv.FormatInt(exp, 10)
}

// SignKnownDevice returns a token "<exp>.<sig>" for username.
func SignKnownDevice(key []byte, username string, now time.Time) string {
	exp := now.Add(KnownDeviceValidity).Unix()
	return strconv.FormatInt(exp, 10) + "." + signMessage(key, knownDeviceMessage(username, exp))
}

// VerifyKnownDevice reports whether token is an unexpired known-device token
// for username (case-insensitive).
func VerifyKnownDevice(key []byte, token, username string, now time.Time) bool {
	if len(key) == 0 || token == "" || username == "" {
		return false
	}
	expStr, sig, ok := strings.Cut(token, ".")
	if !ok {
		return false
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || exp <= 0 || now.Unix() > exp {
		return false
	}
	return verifyMessage(key, knownDeviceMessage(username, exp), sig)
}
