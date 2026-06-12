package httpx

import (
	"context"
	"net"
	"testing"
)

type fakeDownloadResolver map[string][]net.IPAddr

func (r fakeDownloadResolver) LookupIPAddr(_ context.Context, host string) ([]net.IPAddr, error) {
	return r[host], nil
}

func TestValidateDownloadURLRejectsUnsafeTargets(t *testing.T) {
	tests := []string{
		"",
		"ftp://example.com/file.mp3",
		"https:///file.mp3",
		"http://localhost/file.mp3",
		"http://service.localhost/file.mp3",
		"http://127.0.0.1/file.mp3",
		"http://10.0.0.1/file.mp3",
		"http://169.254.169.254/latest/meta-data",
		"http://224.0.0.1/file.mp3",
		"http://192.0.2.1/file.mp3",
		"http://[::1]/file.mp3",
		"http://[2001:db8::1]/file.mp3",
	}
	for _, rawURL := range tests {
		if _, err := ValidateDownloadURL(rawURL, DownloadPolicy{}); err == nil {
			t.Fatalf("ValidateDownloadURL(%q) succeeded, want error", rawURL)
		}
	}
}

func TestValidateDownloadURLAllowsHTTPAndHTTPSPublicHosts(t *testing.T) {
	for _, rawURL := range []string{
		"http://example.com/file.mp3",
		"https://cdn.example.com/path/file.flac",
		"https://8.8.8.8/file.wav",
	} {
		if _, err := ValidateDownloadURL(rawURL, DownloadPolicy{}); err != nil {
			t.Fatalf("ValidateDownloadURL(%q) failed: %v", rawURL, err)
		}
	}
}

func TestResolveDownloadHostRejectsUnsafeDNSAnswers(t *testing.T) {
	resolver := fakeDownloadResolver{
		"public.example": {
			{IP: net.ParseIP("8.8.8.8")},
		},
		"private.example": {
			{IP: net.ParseIP("10.0.0.2")},
		},
		"documentation.example": {
			{IP: net.ParseIP("2001:db8::1")},
		},
		"mixed.example": {
			{IP: net.ParseIP("8.8.8.8")},
			{IP: net.ParseIP("10.0.0.2")},
		},
	}
	if _, err := resolveDownloadHost(context.Background(), resolver, "public.example", DownloadPolicy{}); err != nil {
		t.Fatalf("public resolver result rejected: %v", err)
	}
	for _, host := range []string{"private.example", "documentation.example", "mixed.example"} {
		if _, err := resolveDownloadHost(context.Background(), resolver, host, DownloadPolicy{}); err == nil {
			t.Fatalf("resolveDownloadHost(%q) succeeded, want error", host)
		}
	}
}

func TestResolveDownloadHostCanAllowLoopbackForLocalTests(t *testing.T) {
	resolver := fakeDownloadResolver{
		"localhost": {
			{IP: net.ParseIP("127.0.0.1")},
		},
	}
	if _, err := resolveDownloadHost(context.Background(), resolver, "localhost", DownloadPolicy{}); err == nil {
		t.Fatal("localhost resolved without allowLoopback")
	}
	if _, err := resolveDownloadHost(context.Background(), resolver, "localhost", DownloadPolicy{AllowLoopback: true}); err != nil {
		t.Fatalf("localhost rejected with AllowLoopback: %v", err)
	}
}
