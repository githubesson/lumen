package preview

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
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

func TestBuildAudioArgsCopyAudioIntoM4A(t *testing.T) {
	args := buildAudioArgs("/cache/track-12.mp4", "/cache/track-12-audio.m4a")
	for _, want := range [][]string{
		{"-i", "/cache/track-12.mp4"},
		{"-map", "0:a:0"},
		{"-c:a", "copy"},
		{"-f", "ipod"},
	} {
		i := slices.Index(args, want[0])
		if i < 0 || i+1 >= len(args) || args[i+1] != want[1] {
			t.Fatalf("audio args missing %v: %#v", want, args)
		}
	}
	if args[len(args)-1] != "/cache/track-12-audio.m4a" {
		t.Fatalf("output path must be last for the .part rewrite: %#v", args)
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
	if got, want := b.audioCachePath("track", 12, 30), filepath.Join(b.CacheDir, "track-12-audio.m4a"); got != want {
		t.Fatalf("audio cache path = %q, want %q", got, want)
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

func TestPruneCacheRemovesOnlyStaleFiles(t *testing.T) {
	dir := t.TempDir()
	b := &Builder{CacheDir: dir}
	stale := filepath.Join(dir, "stale.mp4")
	fresh := filepath.Join(dir, "fresh.mp4")
	for _, p := range []string{stale, fresh} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	removed, err := b.PruneCache(24 * time.Hour)
	if err != nil || removed != 1 {
		t.Fatalf("PruneCache = %d, %v; want 1, nil", removed, err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale file still present: %v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("fresh file removed: %v", err)
	}
}
