package handlers

import "testing"

func TestNormalizeInviteMaxUses(t *testing.T) {
	tests := []struct {
		name      string
		requested int
		want      int
		ok        bool
	}{
		{name: "default", requested: 0, want: 1, ok: true},
		{name: "negative defaults", requested: -1, want: 1, ok: true},
		{name: "one", requested: 1, want: 1, ok: true},
		{name: "database maximum", requested: maxInviteUses, want: maxInviteUses, ok: true},
		{name: "above database maximum", requested: maxInviteUses + 1, ok: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := normalizeInviteMaxUses(test.requested)
			if ok != test.ok || got != test.want {
				t.Fatalf("normalizeInviteMaxUses(%d) = (%d, %v), want (%d, %v)", test.requested, got, ok, test.want, test.ok)
			}
		})
	}
}
