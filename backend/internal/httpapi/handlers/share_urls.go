package handlers

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// resolveBaseURL derives the public origin from the request itself —
// X-Forwarded-Host + X-Forwarded-Proto when the reverse proxy forwards
// them (Caddy/nginx both do by default in this repo's deploy configs),
// otherwise r.Host + r.TLS. Either way the origin the user typed in the
// browser is what ends up in share links and og:url.
func resolveBaseURL(r *http.Request) string {
	scheme := fallbackScheme(r)
	if p, ok := validForwardedProto(r.Header.Get("X-Forwarded-Proto")); ok {
		scheme = p
	} else if p, ok := validForwardedProto(forwardedHeaderValue(r.Header.Get("Forwarded"), "proto")); ok {
		scheme = p
	}

	host := r.Host
	if fh, ok := validForwardedHost(r.Header.Get("X-Forwarded-Host")); ok {
		host = fh
	} else if fh, ok := validForwardedHost(forwardedHeaderValue(r.Header.Get("Forwarded"), "host")); ok {
		host = fh
	}
	return scheme + "://" + host
}

func fallbackScheme(r *http.Request) string {
	if r.TLS == nil {
		return "http"
	}
	return "https"
}

func validForwardedProto(raw string) (string, bool) {
	p := strings.ToLower(firstForwardedToken(raw))
	if p != "http" && p != "https" {
		return "", false
	}
	return p, true
}

func validForwardedHost(raw string) (string, bool) {
	host := firstForwardedToken(raw)
	if host == "" || strings.ContainsAny(host, " \t\r\n/\\") {
		return "", false
	}
	u, err := url.Parse("http://" + host)
	if err != nil || u.Host == "" || u.Host != host || u.User != nil {
		return "", false
	}
	if u.Hostname() == "" {
		return "", false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n <= 0 || n > 65535 {
			return "", false
		}
	}
	return host, true
}

func firstForwardedToken(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if i := strings.IndexByte(raw, ','); i >= 0 {
		raw = raw[:i]
	}
	raw = strings.TrimSpace(raw)
	raw = strings.Trim(raw, `"`)
	return strings.TrimSpace(raw)
}

func forwardedHeaderValue(raw string, key string) string {
	first := firstForwardedToken(raw)
	if first == "" {
		return ""
	}
	for _, part := range strings.Split(first, ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(k), key) {
			continue
		}
		return strings.Trim(strings.TrimSpace(v), `"`)
	}
	return ""
}

func shareFrontendURL(base string, id uuid.UUID, startSec int, sig string) string {
	q := url.Values{}
	q.Set("t", strconv.Itoa(startSec))
	q.Set("sig", sig)
	return base + "/shared/track/" + id.String() + "?" + q.Encode()
}

func sharePreviewVideoURL(base string, id uuid.UUID, startSec int, sig string) string {
	q := url.Values{}
	q.Set("t", strconv.Itoa(startSec))
	q.Set("sig", sig)
	return base + "/api/public/preview-videos/" + id.String() + ".mp4?" + q.Encode()
}

func shareEmbedURL(base string, id uuid.UUID, startSec int, sig string) string {
	q := url.Values{}
	q.Set("t", strconv.Itoa(startSec))
	q.Set("sig", sig)
	return base + "/embed/track/" + id.String() + "?" + q.Encode()
}
