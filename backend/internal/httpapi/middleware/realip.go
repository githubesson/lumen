package middleware

import (
	"net"
	"net/http"
	"strings"
)

// TrustedProxies holds the parsed set of proxy addresses (exact IPs or CIDR
// ranges) whose forwarding headers we honor. Untrusted peers have those
// headers stripped so they cannot spoof client IPs or public URL origins.
type TrustedProxies struct {
	ips  map[string]struct{}
	nets []*net.IPNet
}

// ParseTrustedProxies builds a TrustedProxies set from a list of CIDR strings
// (e.g. "10.0.0.0/8") or bare IP literals (e.g. "127.0.0.1"). Empty / invalid
// entries are silently skipped.
func ParseTrustedProxies(spec []string) TrustedProxies {
	tp := TrustedProxies{ips: map[string]struct{}{}}
	for _, s := range spec {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, n, err := net.ParseCIDR(s); err == nil {
			tp.nets = append(tp.nets, n)
			continue
		}
		if ip := net.ParseIP(s); ip != nil {
			tp.ips[ip.String()] = struct{}{}
		}
	}
	return tp
}

func (tp TrustedProxies) Empty() bool {
	return len(tp.ips) == 0 && len(tp.nets) == 0
}

func (tp TrustedProxies) Contains(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if _, ok := tp.ips[ip.String()]; ok {
		return true
	}
	for _, n := range tp.nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// RealIP rewrites r.RemoteAddr to the real client address when the immediate
// peer is a trusted proxy. For every other peer the proxy headers are stripped
// so downstream code (rate limiter, audit IP) cannot be tricked into trusting
// an attacker-supplied X-Forwarded-For. When the trusted set is empty the
// headers are always stripped — there is no proxy in front, so any header is
// untrustworthy by definition.
func RealIP(tp TrustedProxies) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			peer := remoteIP(r.RemoteAddr)
			if tp.Empty() || !tp.Contains(peer) {
				stripForwardingHeaders(r)
				next.ServeHTTP(w, r)
				return
			}
			if client := clientFromXFF(r.Header.Get("X-Forwarded-For"), tp); client != "" {
				r.RemoteAddr = client
			} else if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); real != "" {
				if ip := net.ParseIP(real); ip != nil {
					r.RemoteAddr = ip.String()
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

func stripForwardingHeaders(r *http.Request) {
	r.Header.Del("X-Forwarded-For")
	r.Header.Del("X-Real-IP")
	r.Header.Del("X-Forwarded-Host")
	r.Header.Del("X-Forwarded-Proto")
	r.Header.Del("Forwarded")
}

func remoteIP(addr string) net.IP {
	if addr == "" {
		return nil
	}
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return net.ParseIP(host)
	}
	return net.ParseIP(addr)
}

// clientFromXFF walks X-Forwarded-For right-to-left and returns the first IP
// that isn't itself a trusted proxy — that's the closest hop we can attribute
// to the actual client. Returns "" if any entry is malformed (which we treat
// as "don't trust this header at all" to avoid silently picking the wrong IP).
func clientFromXFF(xff string, tp TrustedProxies) string {
	if xff == "" {
		return ""
	}
	parts := strings.Split(xff, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		p := strings.TrimSpace(parts[i])
		ip := net.ParseIP(p)
		if ip == nil {
			return ""
		}
		if !tp.Contains(ip) {
			return ip.String()
		}
	}
	return ""
}
