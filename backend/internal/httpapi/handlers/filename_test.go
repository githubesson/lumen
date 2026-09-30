package handlers

import "testing"

func TestFileNameHidesDirectoriesOfEitherStyle(t *testing.T) {
	for in, want := range map[string]string{
		"/music/Artist/track.flac":       "track.flac",
		`C:\Users\name\Music\track.flac`: "track.flac",
		`/music/mixed\dir/track.flac`:    "track.flac",
		"track.flac":                     "track.flac",
	} {
		if got := fileName(in); got != want {
			t.Errorf("fileName(%q) = %q, want %q", in, got, want)
		}
	}
}
