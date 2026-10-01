package mediaembed

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
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

// probe returns a file's tags (container and first audio stream, merged,
// keys lower-cased) and its picture streams' codecs, via ffprobe.
func probe(t *testing.T, path string) (map[string]string, []string) {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-print_format", "json",
		"-show_format", "-show_streams", path).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", path, err)
	}
	var info struct {
		Format struct {
			Tags map[string]string `json:"tags"`
		} `json:"format"`
		Streams []struct {
			CodecType   string            `json:"codec_type"`
			CodecName   string            `json:"codec_name"`
			Tags        map[string]string `json:"tags"`
			Disposition map[string]int    `json:"disposition"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &info); err != nil {
		t.Fatal(err)
	}
	tags := map[string]string{}
	add := func(m map[string]string) {
		for k, v := range m {
			tags[strings.ToLower(k)] = v
		}
	}
	add(info.Format.Tags)
	var pics []string
	for _, s := range info.Streams {
		switch {
		case s.CodecType == "audio":
			add(s.Tags)
		case s.Disposition["attached_pic"] == 1:
			pics = append(pics, s.CodecName)
		}
	}
	return tags, pics
}

// libraryFile writes a 1-second tone in format ext with tags the library
// will override, one it won't (genre), and a PNG picture where the
// container holds one.
func libraryFile(t *testing.T, ext string) string {
	t.Helper()
	if !Available() {
		t.Skip("ffmpeg not available")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not available")
	}
	codec := map[string]string{".flac": "flac", ".mp3": "libmp3lame", ".m4a": "aac", ".ogg": "libvorbis", ".opus": "libopus"}[ext]
	path := tempPath(t, ext)
	args := []string{"-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1"}
	hint, _ := HintFromPath(path)
	if pictures(hint) {
		pic := tempPath(t, ".png")
		if out, err := exec.Command("ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi",
			"-i", "color=c=red:s=16x16", "-frames:v", "1", pic).CombinedOutput(); err != nil {
			t.Fatalf("picture: %v (%s)", err, out)
		}
		args = append(args, "-i", pic,
			"-map", "0:a", "-map", "1:v", "-c:v", "copy", "-disposition:v:0", "attached_pic")
	}
	args = append(args, "-c:a", codec,
		"-metadata", "title=File Title", "-metadata", "artist=File Artist",
		"-metadata", "album=File Album", "-metadata", "genre=Rock", path)
	if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Skipf("ffmpeg can't write %s here: %v (%s)", ext, err, out)
	}
	return path
}

// A library file is retagged in its own container from the library's
// metadata, keeping its other tags; the library's cover replaces its
// picture, which stays when there is none.
func TestEmbedFileRetagsLibraryFiles(t *testing.T) {
	meta := Metadata{
		Title: "Library Title", Artist: "Main; Guest", Album: "Library Album", AlbumArtist: "Main",
		Year: 2001, TrackNo: 4, DiscNo: 2, ISRC: "GBAYE0601498", Composer: "Writer",
	}
	for _, ext := range []string{".flac", ".mp3", ".m4a", ".ogg", ".opus"} {
		t.Run(ext, func(t *testing.T) {
			path := libraryFile(t, ext)
			hint, ok := HintFromPath(path)
			if !ok {
				t.Fatalf("no hint for %s", ext)
			}
			before, _ := os.ReadFile(path)
			for _, cover := range [][]byte{minimalJPEG(t), nil} {
				res, err := EmbedFile(context.Background(), path, cover, meta, hint)
				if err != nil {
					t.Fatalf("EmbedFile(cover %v): %v", cover != nil, err)
				}
				if res.Size < 1000 {
					t.Fatalf("output is %d bytes; no audio?", res.Size)
				}
				tags, pics := probe(t, res.File.Name())
				res.Cleanup()
				for k, want := range map[string]string{
					"title": "Library Title", "artist": "Main; Guest", "album": "Library Album",
					"genre": "Rock", "composer": "Writer",
				} {
					if tags[k] != want {
						t.Errorf("cover %v: %s = %q, want %q (tags %v)", cover != nil, k, tags[k], want, tags)
					}
				}
				if !strings.HasPrefix(tags["date"], "2001") || !strings.HasPrefix(tags["track"], "4") {
					t.Errorf("cover %v: date %q, track %q", cover != nil, tags["date"], tags["track"])
				}
				switch {
				case !pictures(hint):
					if len(pics) != 0 {
						t.Errorf("pictures in %s: %v", ext, pics)
					}
				case cover != nil:
					if len(pics) != 1 || pics[0] != "mjpeg" {
						t.Errorf("cover: pictures %v, want the given JPEG", pics)
					}
				default:
					if len(pics) != 1 || pics[0] != "png" {
						t.Errorf("no cover: pictures %v, want the file's own PNG", pics)
					}
				}
			}
			if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
				t.Fatal("the library file was modified")
			}
		})
	}
}

func TestHintFromPath(t *testing.T) {
	for path, want := range map[string]FormatHint{
		"a.FLAC": FormatFLAC, "a.m4a": FormatMP4, "a.mp4": FormatMP4, "a.mp3": FormatMP3,
		"a.ogg": FormatOgg, "a.opus": FormatOpus,
	} {
		if got, ok := HintFromPath(path); !ok || got != want {
			t.Errorf("HintFromPath(%q) = %q, %v", path, got, ok)
		}
	}
	for _, path := range []string{"a.wav", "a.aac", "a.webm", "a"} {
		if _, ok := HintFromPath(path); ok {
			t.Errorf("HintFromPath(%q) is taggable", path)
		}
	}
}

// Ogg can't hold pictures on output, so an Ogg file with art isn't
// retagged (the caller serves it as is) rather than losing its art.
func TestEmbedFileKeepsOggArtByFailing(t *testing.T) {
	if !Available() {
		t.Skip("ffmpeg not available")
	}
	jpeg := minimalJPEG(t)
	be := binary.BigEndian.AppendUint32
	block := be(nil, 3) // front cover
	block = be(block, uint32(len("image/jpeg")))
	block = append(block, "image/jpeg"...)
	block = be(block, 0)                       // no description
	block = be(be(be(be(block, 1), 1), 24), 0) // width, height, depth, colors
	block = append(be(block, uint32(len(jpeg))), jpeg...)
	path := tempPath(t, ".ogg")
	if out, err := exec.Command("ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1",
		"-c:a", "libvorbis", "-metadata", "METADATA_BLOCK_PICTURE="+base64.StdEncoding.EncodeToString(block),
		path).CombinedOutput(); err != nil {
		t.Skipf("ffmpeg can't write Ogg Vorbis here: %v (%s)", err, out)
	}
	if res, err := EmbedFile(context.Background(), path, nil, Metadata{Title: "X"}, FormatOgg); err == nil {
		res.Cleanup()
		t.Fatal("retagged an Ogg file with art, dropping the art")
	}
}
