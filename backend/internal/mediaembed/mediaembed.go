// Package mediaembed shells out to ffmpeg to embed metadata and cover art
// into an assembled audio file (typically fragmented MP4 from TIDAL HLS
// segments). It stream-copies (-c copy) so there is no re-encoding; ffmpeg
// just remuxes the audio into a fresh container with tags and an attached
// picture. If ffmpeg is not on $PATH, callers should fall back to serving
// the raw assembled file without metadata.
package mediaembed

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Metadata is the tag set embedded into the output file.
type Metadata struct {
	Title       string
	Artist      string // joined artist names
	Album       string
	AlbumArtist string
	Year        int
	TrackNo     int
	DiscNo      int
	ISRC        string
}

// embedTimeout bounds a single ffmpeg invocation. -c copy is fast (no
// decode/encode), so this is generous even for long tracks.
const embedTimeout = 120 * time.Second

var (
	ffmpegOnce    sync.Once
	ffmpegPresent bool
)

// Available reports whether ffmpeg is on $PATH. Checked once.
func Available() bool {
	ffmpegOnce.Do(func() {
		_, err := exec.LookPath("ffmpeg")
		ffmpegPresent = err == nil
	})
	return ffmpegPresent
}

// FormatHint tells Embed which container/codec family the input uses so it
// can pick the right output format and temp-file extension.
type FormatHint string

const (
	FormatMP4  FormatHint = "mp4"  // fMP4 / M4A / AAC segments
	FormatFLAC FormatHint = "flac" // FLAC segments
	FormatTS   FormatHint = "ts"   // MPEG-TS (usually AAC inside)
)

// HintFromContentType maps a Content-Type string to a FormatHint.
func HintFromContentType(ct string) FormatHint {
	switch strings.ToLower(strings.TrimSpace(strings.Split(ct, ";")[0])) {
	case "audio/flac", "audio/x-flac":
		return FormatFLAC
	case "video/mp2t":
		return FormatTS
	default:
		return FormatMP4
	}
}

// Result is the tagged file ready for streaming. Call Close (and ideally
// Cleanup) when done to release the temp file.
type Result struct {
	File    *os.File
	Size    int64
	Format  FormatHint
	Ext     string
	Cleanup func()
}

// Embed reads audio from r, embeds the given metadata and optional cover art
// (raw JPEG/PNG bytes), and returns a tagged file. The audio stream is
// closed when ffmpeg finishes. If cover is nil/empty, no cover art is added.
//
// The audio is first written to a temp file (ffmpeg's fMP4 demuxer can't
// reliably read fragmented MP4 from a non-seekable stdin pipe), then
// remuxed with -c copy into a regular (non-fragmented) MP4/FLAC file with
// +faststart so it plays in any player and supports HTTP Range requests.
// The caller should serve it with http.ServeContent.
func Embed(ctx context.Context, r io.ReadCloser, cover []byte, meta Metadata, hint FormatHint) (*Result, error) {
	if !Available() {
		r.Close()
		return nil, errors.New("ffmpeg not available")
	}

	ext, outFormat := outputFormat(hint)
	inExt := inputExt(hint)

	// Write the assembled audio to a temp file first. ffmpeg's fMP4 demuxer
	// needs a seekable input to parse the init segment + fragments correctly;
	// piping through stdin produces empty/corrupt output.
	inFile, err := os.CreateTemp("", "mediaembed-in-*"+inExt)
	if err != nil {
		r.Close()
		return nil, fmt.Errorf("create temp input: %w", err)
	}
	inPath := inFile.Name()
	if _, err := io.Copy(inFile, r); err != nil {
		r.Close()
		inFile.Close()
		os.Remove(inPath)
		return nil, fmt.Errorf("write temp input: %w", err)
	}
	r.Close()
	inFile.Close()

	outPath := inPath + ".out" + ext

	var coverPath string
	if len(cover) > 0 {
		coverExt := ".jpg"
		if len(cover) >= 4 && string(cover[:4]) == "\x89PNG" {
			coverExt = ".png"
		}
		cf, cerr := os.CreateTemp("", "mediaembed-cover-*"+coverExt)
		if cerr != nil {
			os.Remove(inPath)
			return nil, fmt.Errorf("create cover temp: %w", cerr)
		}
		coverPath = cf.Name()
		if _, werr := cf.Write(cover); werr != nil {
			cf.Close()
			os.Remove(coverPath)
			os.Remove(inPath)
			return nil, fmt.Errorf("write cover temp: %w", werr)
		}
		cf.Close()
	}

	args := buildArgs(inPath, outPath, coverPath, meta, outFormat)

	embedCtx, cancel := context.WithTimeout(ctx, embedTimeout)
	defer cancel()

	cmd := exec.CommandContext(embedCtx, "ffmpeg", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		os.Remove(inPath)
		os.Remove(outPath)
		if coverPath != "" {
			os.Remove(coverPath)
		}
		if embedCtx.Err() != nil {
			return nil, fmt.Errorf("ffmpeg timed out: %w", embedCtx.Err())
		}
		return nil, fmt.Errorf("ffmpeg failed: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
	os.Remove(inPath)
	if coverPath != "" {
		os.Remove(coverPath)
	}

	tagged, err := os.Open(outPath)
	if err != nil {
		os.Remove(outPath)
		return nil, fmt.Errorf("reopen tagged file: %w", err)
	}
	stat, err := tagged.Stat()
	if err != nil {
		tagged.Close()
		os.Remove(outPath)
		return nil, fmt.Errorf("stat tagged file: %w", err)
	}
	if stat.Size() == 0 {
		tagged.Close()
		os.Remove(outPath)
		return nil, fmt.Errorf("ffmpeg produced empty output (stderr: %s)", strings.TrimSpace(stderr.String()))
	}

	return &Result{
		File:   tagged,
		Size:   stat.Size(),
		Format: hint,
		Ext:    ext,
		Cleanup: func() {
			tagged.Close()
			os.Remove(outPath)
		},
	}, nil
}

func inputExt(hint FormatHint) string {
	switch hint {
	case FormatFLAC:
		return ".flac"
	case FormatTS:
		return ".ts"
	default:
		return ".m4a"
	}
}

func outputFormat(hint FormatHint) (ext, format string) {
	switch hint {
	case FormatFLAC:
		return ".flac", "flac"
	case FormatTS:
		return ".m4a", "mp4"
	default:
		return ".m4a", "mp4"
	}
}

func buildArgs(inPath, outPath, coverPath string, meta Metadata, outFormat string) []string {
	args := []string{
		"-nostdin",
		"-v", "error",
		"-i", inPath,
	}

	if coverPath != "" {
		args = append(args, "-i", coverPath)
	}

	// Map audio (and cover if present)
	if coverPath != "" {
		args = append(args,
			"-map", "0:a",
			"-map", "1:v",
			"-disposition:v:0", "attached_pic",
		)
	} else {
		args = append(args, "-map", "0:a")
	}

	// Stream copy — no re-encode
	args = append(args, "-c", "copy")
	// Cover art: copy as-is (JPEG stays JPEG inside MP4 covr box)
	if coverPath != "" {
		args = append(args, "-c:v:0", "copy")
	}

	// Metadata tags
	args = append(args, "-metadata", "title="+meta.Title)
	args = append(args, "-metadata", "artist="+meta.Artist)
	args = append(args, "-metadata", "album="+meta.Album)
	args = append(args, "-metadata", "album_artist="+meta.AlbumArtist)
	if meta.Year > 0 {
		args = append(args, "-metadata", "date="+strconv.Itoa(meta.Year))
	}
	if meta.TrackNo > 0 {
		args = append(args, "-metadata", "track="+strconv.Itoa(meta.TrackNo))
	}
	if meta.DiscNo > 0 {
		args = append(args, "-metadata", "disc="+strconv.Itoa(meta.DiscNo))
	}
	if meta.ISRC != "" {
		args = append(args, "-metadata", "isrc="+meta.ISRC)
	}

	// MP4: faststart for progressive playback; write to file (not pipe)
	if outFormat == "mp4" {
		args = append(args, "-movflags", "+faststart")
	}

	args = append(args, "-f", outFormat, outPath)
	return args
}

// ExtFromFormat returns a file extension for the format hint.
func ExtFromFormat(hint FormatHint) string {
	ext, _ := outputFormat(hint)
	return filepath.Ext(ext)
}
