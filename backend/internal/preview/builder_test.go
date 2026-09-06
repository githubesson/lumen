package preview

import (
	"path/filepath"
	"slices"
	"testing"
)

func TestBuildArgsUseSelectedDuration(t *testing.T) {
	args := buildArgs(Input{
		AudioPath:   "/music/track.flac",
		StartSec:    12,
		DurationSec: 75,
	}, "/cache/out.mp4")

	if !slices.Contains(args, "75") {
		t.Fatalf("build args do not contain selected duration: %#v", args)
	}
	for i, arg := range args {
		if arg == "-t" && (i+1 >= len(args) || args[i+1] != "75") {
			t.Fatalf("-t does not use selected duration: %#v", args)
		}
	}
}

func TestDurationAwareCachePathsPreserveDefaultNames(t *testing.T) {
	b := &Builder{CacheDir: t.TempDir()}
	if got, want := b.cachePath("track", 12, 30), filepath.Join(b.CacheDir, "track-12.mp4"); got != want {
		t.Fatalf("default cache path = %q, want %q", got, want)
	}
	if got, want := b.cachePath("track", 12, 75), filepath.Join(b.CacheDir, "track-12-75s.mp4"); got != want {
		t.Fatalf("duration cache path = %q, want %q", got, want)
	}
	if got, want := b.storyBackgroundCachePath("track", 12, 75), filepath.Join(b.CacheDir, "track-12-75s-story-bg-v4.mp4"); got != want {
		t.Fatalf("story cache path = %q, want %q", got, want)
	}
}

func TestNormalizeDurationDefaultsAndCaps(t *testing.T) {
	if got := normalizeDurationSec(0); got != 30 {
		t.Fatalf("default duration = %d, want 30", got)
	}
	if got := normalizeDurationSec(121); got != 120 {
		t.Fatalf("capped duration = %d, want 120", got)
	}
	if got := normalizeDurationSec(3); got != 3 {
		t.Fatalf("short-track duration = %d, want 3", got)
	}
}
