// Package mediaembed shells out to ffmpeg to embed metadata and cover art
// into an audio file: one assembled from TIDAL HLS segments (Embed), or a
// library file on disk (EmbedFile). It stream-copies (-c copy) so there is
// no re-encoding; ffmpeg just remuxes the audio into a fresh container with
// tags and an attached picture. If ffmpeg is not on $PATH, callers should
// fall back to serving the file without metadata.
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

	"github.com/githubesson/lumen/internal/downloadfile"
	"github.com/githubesson/lumen/internal/ffsafe"
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
	// Written only when set; a file's own value stays otherwise.
	Genre    string
	Composer string
	Comment  string
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
	FormatMP3  FormatHint = "mp3"
	FormatOgg  FormatHint = "ogg"  // Ogg Vorbis
	FormatOpus FormatHint = "opus" // Ogg Opus
)

// HintFromPath is the hint for remuxing a library file in its own container,
// by extension. ok is false for formats ffmpeg can't retag that way (WAV
// keeps no usable tags, raw AAC and WebM have none of their own).
func HintFromPath(path string) (hint FormatHint, ok bool) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".flac":
		return FormatFLAC, true
	case ".m4a", ".mp4":
		return FormatMP4, true
	case ".mp3":
		return FormatMP3, true
	case ".ogg":
		return FormatOgg, true
	case ".opus":
		return FormatOpus, true
	}
	return "", false
}

// ContentType is the MIME type of output in hint's format.
func ContentType(hint FormatHint) string {
	switch hint {
	case FormatFLAC:
		return "audio/flac"
	case FormatMP3:
		return "audio/mpeg"
	case FormatOgg:
		return "audio/ogg"
	case FormatOpus:
		return "audio/ogg; codecs=opus"
	default:
		return "audio/mp4"
	}
}

// pictures reports whether hint's container holds cover art ffmpeg can
// write. Ogg can't (ffmpeg has no picture muxing for it), so Ogg output
// carries tags only, and an Ogg file that has art fails to remux rather
// than lose it.
func pictures(hint FormatHint) bool {
	return hint != FormatOgg && hint != FormatOpus
}

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
	// Bounded like every downloaded file (the auto-download worker caps this
	// same TIDAL stream at downloadfile.MaxFileBytes): an upstream that
	// streams without end would otherwise fill the temp volume.
	n, err := io.Copy(inFile, io.LimitReader(r, downloadfile.MaxFileBytes+1))
	if err == nil && n > downloadfile.MaxFileBytes {
		err = downloadfile.ErrTooLarge
	}
	if err != nil {
		r.Close()
		inFile.Close()
		os.Remove(inPath)
		return nil, fmt.Errorf("write temp input: %w", err)
	}
	r.Close()
	inFile.Close()
	defer os.Remove(inPath)
	return embedPath(ctx, inPath, cover, meta, hint)
}

// EmbedFile is Embed for a file already on disk, such as a library track:
// ffmpeg reads it in place, and it is not modified. The tagged copy keeps the
// file's container (hint, see HintFromPath), its audio as is, and its other
// tags; cover, when given, replaces its pictures, which are kept otherwise.
func EmbedFile(ctx context.Context, path string, cover []byte, meta Metadata, hint FormatHint) (*Result, error) {
	if !Available() {
		return nil, errors.New("ffmpeg not available")
	}
	return embedPath(ctx, path, cover, meta, hint)
}

// embedPath runs ffmpeg on the audio at inPath, which it leaves in place.
func embedPath(ctx context.Context, inPath string, cover []byte, meta Metadata, hint FormatHint) (*Result, error) {
	ext, outFormat := outputFormat(hint)
	if !pictures(hint) {
		cover = nil
	}
	out, err := os.CreateTemp("", "mediaembed-out-*"+ext)
	if err != nil {
		return nil, fmt.Errorf("create temp output: %w", err)
	}
	outPath := out.Name()
	out.Close()

	var coverPath string
	if len(cover) > 0 {
		coverExt := ".jpg"
		if len(cover) >= 4 && string(cover[:4]) == "\x89PNG" {
			coverExt = ".png"
		}
		cf, cerr := os.CreateTemp("", "mediaembed-cover-*"+coverExt)
		if cerr != nil {
			os.Remove(outPath)
			return nil, fmt.Errorf("create cover temp: %w", cerr)
		}
		coverPath = cf.Name()
		if _, werr := cf.Write(cover); werr != nil {
			cf.Close()
			os.Remove(coverPath)
			os.Remove(outPath)
			return nil, fmt.Errorf("write cover temp: %w", werr)
		}
		cf.Close()
	}

	args := buildArgs(inPath, outPath, coverPath, meta, outFormat, hint)

	embedCtx, cancel := context.WithTimeout(ctx, embedTimeout)
	defer cancel()

	cmd := exec.CommandContext(embedCtx, "ffmpeg", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		os.Remove(outPath)
		if coverPath != "" {
			os.Remove(coverPath)
		}
		if embedCtx.Err() != nil {
			return nil, fmt.Errorf("ffmpeg timed out: %w", embedCtx.Err())
		}
		return nil, fmt.Errorf("ffmpeg failed: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
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
	case FormatMP3:
		return ".mp3"
	case FormatOgg:
		return ".ogg"
	case FormatOpus:
		return ".opus"
	default:
		return ".m4a"
	}
}

func outputFormat(hint FormatHint) (ext, format string) {
	switch hint {
	case FormatFLAC:
		return ".flac", "flac"
	case FormatMP3:
		return ".mp3", "mp3"
	case FormatOgg:
		return ".ogg", "ogg"
	case FormatOpus:
		return ".opus", "opus"
	default:
		return ".m4a", "mp4"
	}
}

func buildArgs(inPath, outPath, coverPath string, meta Metadata, outFormat string, hint FormatHint) []string {
	args := []string{
		"-nostdin",
		"-v", "error",
		// The output is a temp file of ours, created to reserve its name.
		"-y",
	}
	// file: keeps a path from being read as another protocol, and the
	// whitelists keep ffmpeg from sniffing the content as a playlist that
	// fetches URLs or reads other files (inPath may be any user's upload).
	args = append(args, ffsafe.InputArgs()...)
	args = append(args, "-i", "file:"+inPath)

	if coverPath != "" {
		args = append(args, ffsafe.ImageInputArgs()...)
		args = append(args, "-i", "file:"+coverPath)
	}

	// The audio, and the given cover or else the input's own pictures. Ogg
	// output can't hold pictures, so an Ogg input with art fails here rather
	// than lose it (callers then serve the file as is).
	if coverPath != "" {
		args = append(args,
			"-map", "0:a",
			"-map", "1:v",
			"-disposition:v:0", "attached_pic",
		)
	} else {
		args = append(args, "-map", "0:a", "-map", "0:v?")
	}

	// Stream copy — no re-encode
	args = append(args, "-c", "copy")
	// Cover art: copy as-is (JPEG stays JPEG inside MP4 covr box)
	if coverPath != "" {
		args = append(args, "-c:v:0", "copy")
	}

	// Metadata tags. Ogg keeps its tags on the audio stream rather than the
	// container. The input's other tags are copied as they are.
	tag := "-metadata"
	if hint == FormatOgg || hint == FormatOpus {
		tag = "-metadata:s:a:0"
	}
	set := func(key, value string) { args = append(args, tag, key+"="+value) }
	set("title", meta.Title)
	set("artist", meta.Artist)
	set("album", meta.Album)
	set("album_artist", meta.AlbumArtist)
	if meta.Year > 0 {
		set("date", strconv.Itoa(meta.Year))
	}
	if meta.TrackNo > 0 {
		set("track", strconv.Itoa(meta.TrackNo))
	}
	if meta.DiscNo > 0 {
		set("disc", strconv.Itoa(meta.DiscNo))
	}
	if meta.ISRC != "" {
		set("isrc", meta.ISRC)
	}
	if meta.Genre != "" {
		set("genre", meta.Genre)
	}
	if meta.Composer != "" {
		set("composer", meta.Composer)
	}
	if meta.Comment != "" {
		set("comment", meta.Comment)
	}

	switch outFormat {
	case "mp4":
		// faststart for progressive playback; write to file (not pipe)
		args = append(args, "-movflags", "+faststart")
	case "mp3":
		// ID3v2.3: what most players and file browsers read.
		args = append(args, "-id3v2_version", "3")
	}

	args = append(args, "-f", outFormat, "file:"+outPath)
	return args
}

// ExtFromFormat returns a file extension for the format hint.
func ExtFromFormat(hint FormatHint) string {
	ext, _ := outputFormat(hint)
	return filepath.Ext(ext)
}
