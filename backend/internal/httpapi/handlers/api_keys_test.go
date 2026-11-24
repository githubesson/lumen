package handlers

import "testing"

func TestNormalizeAPIKeyName(t *testing.T) {
	for _, c := range []struct {
		raw, want string
		ok        bool
	}{
		{"  stats script  ", "stats script", true},
		{"👨‍💻 laptop", "👨‍💻 laptop", true},
		{"", "", false},
		{"   ", "", false},
		{"tab\tname", "", false},
		{"​​", "", false},
		{"⁠", "", false},
		{"evil‮gnp.exe", "", false},
		{"isolate⁦x⁩", "", false},
	} {
		got, ok := normalizeAPIKeyName(c.raw)
		if got != c.want || ok != c.ok {
			t.Errorf("normalizeAPIKeyName(%q) = %q, %v; want %q, %v", c.raw, got, ok, c.want, c.ok)
		}
	}
}
