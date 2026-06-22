package mediaembed

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// generateSilentMP4 creates a tiny 1-second silent MP4 file using ffmpeg.
// This serves as input for the Embed test. A regular (non-fragmented) MP4
// is fine here — we're testing that Embed adds metadata, not fMP4 parsing.
func generateSilentMP4(t *testing.T) []byte {
	t.Helper()
	if !Available() {
		t.Skip("ffmpeg not available")
	}
	outPath := tempPath(t, ".m4a")
	cmd := exec.CommandContext(context.Background(), "ffmpeg",
		"-nostdin", "-v", "error",
		"-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=44100",
		"-t", "1",
		"-c", "aac",
		"-f", "mp4",
		outPath,
	)
	if err := cmd.Run(); err != nil {
		t.Fatalf("generate silent MP4: %v", err)
	}
	data, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("read generated MP4: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("generated MP4 is empty")
	}
	return data
}

// tempPath creates a unique temp file path with the given extension. The
// caller is responsible for cleaning up the file at this path.
func tempPath(t *testing.T, ext string) string {
	t.Helper()
	f, err := os.CreateTemp("", "mediaembed-test-*"+ext)
	if err != nil {
		t.Fatalf("create temp: %v", err)
	}
	name := f.Name()
	f.Close()
	os.Remove(name) // remove the empty file so ffmpeg can create it fresh
	t.Cleanup(func() { os.Remove(name) })
	return name
}

func TestEmbedMP4Metadata(t *testing.T) {
	if !Available() {
		t.Skip("ffmpeg not available")
	}

	audio := generateSilentMP4(t)

	// Minimal 1x1 JPEG for cover art.
	cover := minimalJPEG(t)

	meta := Metadata{
		Title:       "Test Title",
		Artist:      "Test Artist",
		Album:       "Test Album",
		AlbumArtist: "Test Album Artist",
		Year:        2024,
		TrackNo:     3,
		DiscNo:      1,
		ISRC:        "TEST12345678",
	}

	result, err := Embed(context.Background(), io.NopCloser(bytes.NewReader(audio)), cover, meta, FormatMP4)
	if err != nil {
		t.Fatalf("Embed failed: %v", err)
	}
	defer result.Cleanup()

	if result.Size == 0 {
		t.Fatal("result file is 0 bytes")
	}
	if result.Size < int64(len(audio)) {
		t.Fatalf("result size %d smaller than input %d — metadata not embedded?", result.Size, len(audio))
	}

	// Verify the output is a valid MP4 by checking it starts with ftyp/moov.
	header := make([]byte, 12)
	n, _ := result.File.ReadAt(header, 0)
	if n < 8 {
		t.Fatalf("could not read header: only %d bytes", n)
	}
	// MP4 files have a box size (4 bytes) then a 4-char box type. The first
	// box should be "ftyp" for a non-fragmented MP4.
	boxType := string(header[4:8])
	if boxType != "ftyp" {
		t.Fatalf("output does not start with ftyp box (got %q) — not a valid MP4", boxType)
	}

	// Verify metadata was embedded by probing with ffprobe.
	probeOutput := ffprobeTags(t, result.File.Name())
	for _, want := range []string{"Test Title", "Test Artist", "Test Album"} {
		if !strings.Contains(probeOutput, want) {
			t.Errorf("ffprobe output missing %q in:\n%s", want, probeOutput)
		}
	}
}

func TestEmbedFallsBackOnEmptyInput(t *testing.T) {
	if !Available() {
		t.Skip("ffmpeg not available")
	}

	_, err := Embed(context.Background(), io.NopCloser(bytes.NewReader(nil)), nil, Metadata{}, FormatMP4)
	if err == nil {
		t.Fatal("expected error for empty input, got nil")
	}
}

func TestEmbedFLACMetadata(t *testing.T) {
	if !Available() {
		t.Skip("ffmpeg not available")
	}

	// Generate 1s of silent FLAC.
	flacPath := tempPath(t, ".flac")
	cmd := exec.CommandContext(context.Background(), "ffmpeg",
		"-nostdin", "-v", "error",
		"-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=44100",
		"-t", "1",
		"-ar", "44100",
		"-c", "flac",
		flacPath,
	)
	if err := cmd.Run(); err != nil {
		t.Fatalf("generate silent FLAC: %v", err)
	}
	audio, err := os.ReadFile(flacPath)
	if err != nil {
		t.Fatalf("read generated FLAC: %v", err)
	}
	if len(audio) == 0 {
		t.Fatal("generated FLAC is empty")
	}

	meta := Metadata{
		Title:  "FLAC Test",
		Artist: "FLAC Artist",
		Year:   2025,
	}

	result, err := Embed(context.Background(), io.NopCloser(bytes.NewReader(audio)), nil, meta, FormatFLAC)
	if err != nil {
		t.Fatalf("Embed failed: %v", err)
	}
	defer result.Cleanup()

	if result.Size == 0 {
		t.Fatal("result file is 0 bytes")
	}

	// FLAC files start with "fLaC" magic.
	header := make([]byte, 4)
	n, _ := result.File.ReadAt(header, 0)
	if n < 4 || string(header) != "fLaC" {
		t.Fatalf("output does not start with fLaC magic (got %q)", string(header[:n]))
	}

	probeOutput := ffprobeTags(t, result.File.Name())
	if !strings.Contains(probeOutput, "FLAC Test") {
		t.Errorf("ffprobe missing FLAC Test title in:\n%s", probeOutput)
	}
}

// ffprobeTags runs ffprobe -show_format and returns the output.
func ffprobeTags(t *testing.T, path string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_format", path)
	out, err := cmd.Output()
	if err != nil {
		t.Logf("ffprobe failed: %v (path: %s)", err, path)
		return ""
	}
	return string(out)
}

// minimalJPEG returns a valid 2x2 JPEG file.
func minimalJPEG(t *testing.T) []byte {
	t.Helper()
	jpgPath := tempPath(t, ".jpg")
	cmd := exec.CommandContext(context.Background(), "ffmpeg",
		"-nostdin", "-v", "error",
		"-f", "lavfi", "-i", "color=c=red:s=2x2:d=1",
		"-frames:v", "1",
		"-y",
		jpgPath,
	)
	if err := cmd.Run(); err != nil {
		t.Fatalf("generate JPEG: %v", err)
	}
	data, err := os.ReadFile(jpgPath)
	if err != nil {
		t.Fatalf("read JPEG: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("generated JPEG is empty")
	}
	return data
}

func TestExtFromFormat(t *testing.T) {
	if ext := ExtFromFormat(FormatMP4); ext != ".m4a" {
		t.Errorf("FormatMP4 ext = %q, want .m4a", ext)
	}
	if ext := ExtFromFormat(FormatFLAC); ext != ".flac" {
		t.Errorf("FormatFLAC ext = %q, want .flac", ext)
	}
}

func TestHintFromContentType(t *testing.T) {
	tests := []struct {
		ct   string
		want FormatHint
	}{
		{"audio/flac", FormatFLAC},
		{"audio/x-flac", FormatFLAC},
		{"video/mp2t", FormatTS},
		{"audio/mp4", FormatMP4},
		{"application/octet-stream", FormatMP4},
		{"", FormatMP4},
	}
	for _, tt := range tests {
		if got := HintFromContentType(tt.ct); got != tt.want {
			t.Errorf("HintFromContentType(%q) = %q, want %q", tt.ct, got, tt.want)
		}
	}
}
