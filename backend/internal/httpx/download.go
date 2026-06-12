package httpx

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// DownloadPolicy tunes the SSRF protections applied to outbound download
// requests. The zero value is the production policy (loopback blocked); tests
// set AllowLoopback to talk to local httptest servers.
type DownloadPolicy struct {
	AllowLoopback bool
}

// Resolver is the subset of *net.Resolver the download security layer needs;
// tests substitute a fake to simulate DNS answers.
type Resolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

var (
	defaultDownloadClient = NewDownloadClient(DownloadPolicy{}, net.DefaultResolver)

	blockedDownloadPrefixes = []netip.Prefix{
		netip.MustParsePrefix("0.0.0.0/8"),
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("100.64.0.0/10"),
		netip.MustParsePrefix("127.0.0.0/8"),
		netip.MustParsePrefix("169.254.0.0/16"),
		netip.MustParsePrefix("172.16.0.0/12"),
		netip.MustParsePrefix("192.0.0.0/24"),
		netip.MustParsePrefix("192.0.2.0/24"),
		netip.MustParsePrefix("192.168.0.0/16"),
		netip.MustParsePrefix("198.18.0.0/15"),
		netip.MustParsePrefix("198.51.100.0/24"),
		netip.MustParsePrefix("203.0.113.0/24"),
		netip.MustParsePrefix("224.0.0.0/4"),
		netip.MustParsePrefix("240.0.0.0/4"),
		netip.MustParsePrefix("255.255.255.255/32"),
		netip.MustParsePrefix("::/128"),
		netip.MustParsePrefix("::1/128"),
		netip.MustParsePrefix("64:ff9b::/96"),
		netip.MustParsePrefix("64:ff9b:1::/48"),
		netip.MustParsePrefix("100::/64"),
		netip.MustParsePrefix("2001::/23"),
		netip.MustParsePrefix("2001:db8::/32"),
		netip.MustParsePrefix("2002::/16"),
		netip.MustParsePrefix("fc00::/7"),
		netip.MustParsePrefix("fe80::/10"),
		netip.MustParsePrefix("ff00::/8"),
	}
)

// DefaultDownloadClient returns the shared SSRF-hardened HTTP client built
// with the production policy. Callers must not mutate it.
func DefaultDownloadClient() *http.Client {
	return defaultDownloadClient
}

// NewDownloadClient builds an SSRF-hardened *http.Client: its dialer
// re-resolves and rejects loopback/private/CGNAT/etc. addresses, and every
// redirect hop is re-validated with ValidateDownloadURL.
func NewDownloadClient(policy DownloadPolicy, resolver Resolver) *http.Client {
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = secureDownloadDialContext(policy, resolver)
	return &http.Client{
		Transport: transport,
		Timeout:   30 * time.Minute,
		CheckRedirect: func(req *http.Request, _ []*http.Request) error {
			if _, err := ValidateDownloadURL(req.URL.String(), policy); err != nil {
				return err
			}
			return nil
		},
	}
}

func secureDownloadDialContext(policy DownloadPolicy, resolver Resolver) func(context.Context, string, string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		addrs, err := resolveDownloadHost(ctx, resolver, host, policy)
		if err != nil {
			return nil, err
		}
		for _, addr := range addrs {
			if network == "tcp4" && !addr.Is4() {
				continue
			}
			if network == "tcp6" && !addr.Is6() {
				continue
			}
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(addr.String(), port))
			if err == nil {
				return conn, nil
			}
		}
		return nil, fmt.Errorf("download host has no usable address")
	}
}

// ValidateDownloadURL checks that rawURL is a plausible, policy-allowed
// download target: http(s) scheme, a non-empty host, and—when the host is a
// literal IP—an address outside the blocked ranges. Hostname targets are
// additionally enforced at dial time by the hardened client's resolver check.
func ValidateDownloadURL(rawURL string, policy DownloadPolicy) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return nil, fmt.Errorf("invalid download URL")
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
	default:
		return nil, fmt.Errorf("download URL scheme is not allowed")
	}
	host := strings.TrimSpace(u.Hostname())
	if host == "" {
		return nil, fmt.Errorf("download URL host is required")
	}
	if strings.Contains(host, "%") {
		return nil, fmt.Errorf("download URL host is not allowed")
	}
	if isLocalhostName(host) && !policy.AllowLoopback {
		return nil, fmt.Errorf("download URL host is not allowed")
	}
	if addr, err := netip.ParseAddr(host); err == nil && isBlockedDownloadAddr(addr, policy) {
		return nil, fmt.Errorf("download URL host is not allowed")
	}
	return u, nil
}

func resolveDownloadHost(ctx context.Context, resolver Resolver, host string, policy DownloadPolicy) ([]netip.Addr, error) {
	host = strings.TrimSpace(host)
	if isLocalhostName(host) && !policy.AllowLoopback {
		return nil, fmt.Errorf("download host is not allowed")
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		if isBlockedDownloadAddr(addr, policy) {
			return nil, fmt.Errorf("download host resolves to a disallowed address")
		}
		return []netip.Addr{addr.Unmap()}, nil
	}
	ips, err := resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	addrs := make([]netip.Addr, 0, len(ips))
	for _, ip := range ips {
		addr, ok := netip.AddrFromSlice(ip.IP)
		if !ok {
			return nil, fmt.Errorf("download host resolved to an invalid address")
		}
		addr = addr.Unmap()
		if isBlockedDownloadAddr(addr, policy) {
			return nil, fmt.Errorf("download host resolves to a disallowed address")
		}
		addrs = append(addrs, addr)
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("download host resolved to no addresses")
	}
	return addrs, nil
}

func isBlockedDownloadAddr(addr netip.Addr, policy DownloadPolicy) bool {
	addr = addr.Unmap()
	if policy.AllowLoopback && addr.IsLoopback() {
		return false
	}
	for _, prefix := range blockedDownloadPrefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return !addr.IsGlobalUnicast()
}

func isLocalhostName(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	return host == "localhost" || strings.HasSuffix(host, ".localhost")
}
