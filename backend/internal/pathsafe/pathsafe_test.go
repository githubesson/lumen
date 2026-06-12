package pathsafe

import (
	"path/filepath"
	"testing"
)

func abs(t *testing.T, p string) string {
	t.Helper()
	a, err := filepath.Abs(p)
	if err != nil {
		t.Fatalf("abs(%q): %v", p, err)
	}
	return a
}

func TestWithinRoot(t *testing.T) {
	root := abs(t, filepath.Join("srv", "music"))
	cases := []struct {
		name   string
		target string
		want   bool
	}{
		{"child file", filepath.Join(root, "album", "track.flac"), true},
		{"root itself", root, true},
		{"nested", filepath.Join(root, "a", "b", "c"), true},
		{"parent escape", filepath.Join(root, ".."), false},
		{"dotdot traversal", filepath.Join(root, "..", "etc", "passwd"), false},
		// The classic sibling-prefix attack: string prefixing would accept this.
		{"sibling prefix", abs(t, filepath.Join("srv", "music-archive", "evil")), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ok, err := WithinRoot(root, tc.target)
			if err != nil {
				t.Fatalf("WithinRoot error: %v", err)
			}
			if ok != tc.want {
				t.Fatalf("WithinRoot(%q, %q) = %v, want %v", root, tc.target, ok, tc.want)
			}
		})
	}
}

func TestWithinAnyRoot(t *testing.T) {
	r1 := abs(t, filepath.Join("data", "one"))
	r2 := abs(t, filepath.Join("data", "two"))
	roots := []string{r1, r2}

	if !WithinAnyRoot(roots, filepath.Join(r2, "x", "y")) {
		t.Fatal("expected target under r2 to be within roots")
	}
	if WithinAnyRoot(roots, abs(t, filepath.Join("data", "three", "z"))) {
		t.Fatal("expected target under an unlisted root to be rejected")
	}
}

func TestCleanSubdir(t *testing.T) {
	root := abs(t, filepath.Join("srv", "pins"))

	got, err := CleanSubdir(root, filepath.Join("artist", "album"))
	if err != nil {
		t.Fatalf("CleanSubdir relative: %v", err)
	}
	if want := filepath.Join(root, "artist", "album"); got != want {
		t.Fatalf("CleanSubdir = %q, want %q", got, want)
	}

	if _, err := CleanSubdir(root, filepath.Join("..", "escape")); err == nil {
		t.Fatal("expected traversal subdir to be rejected")
	}

	absSub := abs(t, filepath.Join("etc", "passwd"))
	if _, err := CleanSubdir(root, absSub); err == nil {
		t.Fatal("expected absolute subdir to be rejected")
	}
}
