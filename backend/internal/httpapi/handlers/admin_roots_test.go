package handlers

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCoveringRoot(t *testing.T) {
	dir := t.TempDir()
	music := filepath.Join(dir, "music")
	for _, d := range []string{
		filepath.Join(music, "artist"),
		filepath.Join(music, ".archive"),
		filepath.Join(dir, "music-archive"),
		filepath.Join(dir, "elsewhere", "inner"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(dir, "elsewhere"), filepath.Join(music, "link")); err != nil {
		t.Fatal(err)
	}
	watched := []string{music, filepath.Join(music, "artist")}
	for _, tc := range []struct{ path, want string }{
		{filepath.Join(music, "artist"), music},
		{filepath.Join(music, "artist") + "/", music},
		// A sibling that only shares a name prefix isn't inside.
		{filepath.Join(dir, "music-archive"), ""},
		// The scanner skips dot-directories and doesn't follow symlinks.
		{filepath.Join(music, ".archive"), ""},
		{filepath.Join(music, "link", "inner"), ""},
		{music, ""},
	} {
		if got := coveringRoot(tc.path, watched); got != tc.want {
			t.Errorf("coveringRoot(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}
