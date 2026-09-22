package config

import (
	"strings"
	"testing"
	"time"
)

func TestBoolenvRejectsMalformedValue(t *testing.T) {
	t.Setenv("TEST_BOOLEAN", "sometimes")
	if _, err := boolenv("TEST_BOOLEAN", true); err == nil || !strings.Contains(err.Error(), "TEST_BOOLEAN") {
		t.Fatalf("boolenv error = %v, want named validation error", err)
	}
}

func TestDurenvRejectsMalformedAndNonPositiveValues(t *testing.T) {
	for _, value := range []string{"later", "0s", "-1m"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("TEST_DURATION", value)
			if _, err := durenv("TEST_DURATION", time.Minute); err == nil || !strings.Contains(err.Error(), "TEST_DURATION") {
				t.Fatalf("durenv(%q) error = %v, want named validation error", value, err)
			}
		})
	}
}

func TestProxyenvValidatesEveryEntry(t *testing.T) {
	t.Setenv("TEST_PROXIES", "127.0.0.1,10.0.0.0/8")
	values, err := proxyenv("TEST_PROXIES")
	if err != nil || len(values) != 2 {
		t.Fatalf("proxyenv valid = %v, %v", values, err)
	}

	t.Setenv("TEST_PROXIES", "127.0.0.1,not-an-address")
	if _, err := proxyenv("TEST_PROXIES"); err == nil || !strings.Contains(err.Error(), "not-an-address") {
		t.Fatalf("proxyenv invalid error = %v", err)
	}
}

func TestNonnegintenv(t *testing.T) {
	t.Setenv("TEST_QUOTA", "")
	if n, err := nonnegintenv("TEST_QUOTA", 7); err != nil || n != 7 {
		t.Fatalf("default = %d, %v", n, err)
	}
	t.Setenv("TEST_QUOTA", "0")
	if n, err := nonnegintenv("TEST_QUOTA", 7); err != nil || n != 0 {
		t.Fatalf("zero = %d, %v", n, err)
	}
	for _, value := range []string{"-1", "lots", "1099511627777"} {
		t.Setenv("TEST_QUOTA", value)
		if _, err := nonnegintenv("TEST_QUOTA", 7); err == nil || !strings.Contains(err.Error(), "TEST_QUOTA") {
			t.Fatalf("nonnegintenv(%q) error = %v, want named validation error", value, err)
		}
	}
}
