package filen

import (
	"path/filepath"
	"testing"
)

func TestHelperPathInDestination(t *testing.T) {
	parent := t.TempDir()
	base := filepath.Join(parent, "download")

	tests := []struct {
		name string
		path string
		ok   bool
	}{
		{
			name: "nested file",
			path: filepath.Join(base, "album", "song.mp3"),
			ok:   true,
		},
		{
			name: "destination prefix sibling",
			path: filepath.Join(parent, "download-evil", "song.mp3"),
			ok:   false,
		},
		{
			name: "parent traversal",
			path: filepath.Join(base, "..", "other", "song.mp3"),
			ok:   false,
		},
		{
			name: "relative path",
			path: filepath.Join("album", "song.mp3"),
			ok:   false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := helperPathInDestination(base, tc.path)
			if ok != tc.ok {
				t.Fatalf("helperPathInDestination(%q, %q) ok = %v, want %v", base, tc.path, ok, tc.ok)
			}
			if ok && !filepath.IsAbs(got) {
				t.Fatalf("helperPathInDestination returned non-absolute path %q", got)
			}
		})
	}
}
