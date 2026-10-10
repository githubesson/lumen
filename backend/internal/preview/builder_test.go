package preview

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/githubesson/lumen/internal/safego"
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

// A render runs inside singleflight's DoChan, which re-raises a panic on a
// goroutine of its own: unguarded, this test would crash the test binary.
func TestEnsureBuiltSurvivesPanickingRender(t *testing.T) {
	b := &Builder{CacheDir: t.TempDir()}
	in := Input{TrackID: "track", AudioPath: "/music/x.mp3", DurationSec: 30}
	_, err := b.ensureBuilt(context.Background(), in, "test", b.cachePath("track", 0, 30),
		func(context.Context, Input, string) error {
			var m map[string]int
			m["boom"]++ // assignment to entry in nil map
			return nil
		})
	if !errors.Is(err, safego.ErrPanicked) {
		t.Fatalf("err = %v, want safego.ErrPanicked", err)
	}
}

// The audio input is an untrusted upload: ffmpeg must not be free to pick a
// playlist demuxer or a network protocol for it.
func TestBuildArgsRestrictAudioInput(t *testing.T) {
	for name, args := range map[string][]string{
		"preview":      buildArgs(Input{AudioPath: "/music/x.mp3", CoverPath: "/c.jpg"}, "/out.mp4"),
		"preview-bare": buildArgs(Input{AudioPath: "/music/x.mp3"}, "/out.mp4"),
		"story":        buildStoryArgs(Input{AudioPath: "/music/x.mp3"}, "/frame.png", "/out.mp4"),
	} {
		audio := slices.Index(args, "/music/x.mp3")
		if audio < 1 || args[audio-1] != "-i" {
			t.Fatalf("%s: audio input not found: %#v", name, args)
		}
		// Options between the previous input and this -i apply to this input.
		prevInput := -1
		for i := audio - 2; i >= 0; i-- {
			if args[i] == "-i" {
				prevInput = i
				break
			}
		}
		opts := args[prevInput+1 : audio-1]
		for _, want := range []string{"-protocol_whitelist", "-format_whitelist"} {
			if !slices.Contains(opts, want) {
				t.Fatalf("%s: %s missing before the audio input: %#v", name, want, args)
			}
		}
	}
}

// The cover comes from storage or TIDAL's CDN as bytes a temp file's
// extension only guesses at: ffmpeg must not be free to read it as a
// playlist either.
func TestBuildArgsRestrictCoverInput(t *testing.T) {
	args := buildArgs(Input{AudioPath: "/music/x.mp3", CoverPath: "/c.jpg"}, "/out.mp4")
	cover := slices.Index(args, "/c.jpg")
	if cover < 1 || args[cover-1] != "-i" || slices.Index(args, "-i") != cover-1 {
		t.Fatalf("cover is not the first input: %#v", args)
	}
	opts := args[:cover-1]
	for _, want := range []string{"-protocol_whitelist", "-format_whitelist", "-loop"} {
		if !slices.Contains(opts, want) {
			t.Fatalf("%s missing before the cover input: %#v", want, args)
		}
	}
}

// Every format a cover is stored or fetched in must still pass the cover
// input's demuxer whitelist and render.
func TestPreviewRendersEachCoverFormat(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not available")
	}
	dir := t.TempDir()
	ffmpeg := func(args ...string) error {
		out, err := exec.Command("ffmpeg", append([]string{"-nostdin", "-v", "error"}, args...)...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("%w (%s)", err, out)
		}
		return nil
	}
	audio := filepath.Join(dir, "tone.flac")
	if err := ffmpeg("-f", "lavfi", "-i", "sine=duration=6", "-c:a", "flac", audio); err != nil {
		t.Fatal(err)
	}
	// Noise, so the JPEG is cover-sized: ffmpeg only sniffs a JPEG whose
	// end it sees in its first probe read, and goes by extension otherwise.
	src := image.NewRGBA(image.Rect(0, 0, 256, 256))
	_, _ = rand.NewChaCha8([32]byte{}).Read(src.Pix)
	covers := map[string]func(io.Writer) error{
		// JPEG as ingest stores covers (image2, by extension, and jpeg_pipe
		// without one); PNG as older covers were kept, also under a .jpg
		// name, since temp files take the key's or URL's extension.
		"cover.jpg":     func(w io.Writer) error { return jpeg.Encode(w, src, nil) },
		"cover":         func(w io.Writer) error { return jpeg.Encode(w, src, nil) },
		"cover.png":     func(w io.Writer) error { return png.Encode(w, src) },
		"png-cover.jpg": func(w io.Writer) error { return png.Encode(w, src) },
	}
	paths := map[string]string{}
	for name, encode := range covers {
		var buf bytes.Buffer
		if err := encode(&buf); err != nil {
			t.Fatal(err)
		}
		paths[name] = filepath.Join(dir, name)
		if err := os.WriteFile(paths[name], buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	webp := filepath.Join(dir, "cover.webp")
	if err := ffmpeg("-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", "-c:v", "libwebp", webp); err != nil {
		t.Logf("skipping WebP: ffmpeg can't write it here: %v", err)
	} else {
		paths["cover.webp"] = webp
	}
	for name, path := range paths {
		b := &Builder{CacheDir: filepath.Join(dir, "cache-"+name)}
		out, err := b.EnsureBuilt(context.Background(), Input{TrackID: "t", AudioPath: audio, CoverPath: path, DurationSec: 5})
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if st, err := os.Stat(out); err != nil || st.Size() == 0 {
			t.Errorf("%s: no preview written: %v", name, err)
		}
	}
}
