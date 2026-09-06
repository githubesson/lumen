package filen

import (
	"errors"
	"net/url"
	"strings"
)

// ErrInvalidShareURL is returned for a share URL that is not a plain
// http(s) URL with a host.
var ErrInvalidShareURL = errors.New("share_url must be an http(s) URL")

// ValidateShareURL normalizes and checks an admin-supplied Filen share link.
//
// The URL reaches the node helper as a *positional* argv element. There is no
// shell involved, so this was never command injection — but a value starting
// with "-" is parsed as an option rather than a URL, so a pin created with
// `--password` or `--help` as its share_url silently derails the helper's
// argument parsing. Requiring a scheme and a host removes that class outright.
func ValidateShareURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", ErrInvalidShareURL
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", ErrInvalidShareURL
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", ErrInvalidShareURL
	}
	if u.Host == "" {
		return "", ErrInvalidShareURL
	}
	return trimmed, nil
}
