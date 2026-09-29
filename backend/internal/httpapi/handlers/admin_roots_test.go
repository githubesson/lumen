package handlers

import "testing"

func TestCoveringRoot(t *testing.T) {
	watched := []string{"/mnt/music", "/mnt/music/artist", "/srv/extra"}
	for _, tc := range []struct{ path, want string }{
		{"/mnt/music/artist", "/mnt/music"},
		{"/mnt/music/artist/", "/mnt/music"},
		// A sibling that only shares a name prefix isn't inside.
		{"/mnt/music-archive", ""},
		{"/srv/extra", ""},
		{"/elsewhere", ""},
	} {
		if got := coveringRoot(tc.path, watched); got != tc.want {
			t.Errorf("coveringRoot(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}
